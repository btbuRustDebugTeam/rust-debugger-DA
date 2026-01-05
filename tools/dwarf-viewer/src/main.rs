use clap::{Parser, Subcommand};
use gimli::{
    AttributeValue, DW_AT_name, DW_AT_type, DW_AT_low_pc, DW_AT_high_pc,
    DW_AT_containing_type, DW_AT_linkage_name, DW_AT_location,
    DebuggingInformationEntry, Dwarf, EndianSlice, LittleEndian, Reader, Unit,
    UnitOffset, UnitSectionOffset,
};
use memmap2::Mmap;
use object::{Object, ObjectSection};
use std::{borrow::Cow, fs::File, path::PathBuf};

type R<'a> = EndianSlice<'a, LittleEndian>;

#[derive(Parser)]
#[command(name = "dwarf-viewer", about = "View DWARF debug info using gimli")]
struct Cli {
    /// Path to ELF binary
    binary: PathBuf,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List all compilation units
    Units,
    /// Dump all DIEs in all units
    Dump {
        /// Max depth to display (0 = unlimited)
        #[arg(short, long, default_value = "0")]
        depth: usize,
    },
    /// Search for DIEs by name
    Search {
        /// Name pattern to search for
        pattern: String,
        /// Search in DW_AT_linkage_name too
        #[arg(short, long)]
        linkage: bool,
    },
    /// Show async/future related DIEs
    Async,
    /// Show all vtables
    Vtables,
    /// Show a specific DIE by offset
    Die {
        /// Hex offset (e.g., 0x1a9)
        offset: String,
    },
    /// Show types (structures, enums)
    Types {
        /// Filter by name pattern
        #[arg(short, long)]
        filter: Option<String>,
    },
    /// Show subprograms (functions)
    Functions {
        /// Filter by name pattern
        #[arg(short, long)]
        filter: Option<String>,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let file = File::open(&cli.binary)?;
    let mmap = unsafe { Mmap::map(&file)? };
    let object = object::File::parse(&*mmap)?;
    let dwarf = load_dwarf(&object)?;

    match cli.command {
        Commands::Units => list_units(&dwarf)?,
        Commands::Dump { depth } => dump_all(&dwarf, depth)?,
        Commands::Search { pattern, linkage } => search(&dwarf, &pattern, linkage)?,
        Commands::Async => show_async(&dwarf)?,
        Commands::Vtables => show_vtables(&dwarf)?,
        Commands::Die { offset } => show_die(&dwarf, &offset)?,
        Commands::Types { filter } => show_types(&dwarf, filter.as_deref())?,
        Commands::Functions { filter } => show_functions(&dwarf, filter.as_deref())?,
    }

    Ok(())
}

fn load_dwarf<'a>(object: &'a object::File<'a>) -> Result<Dwarf<R<'a>>, gimli::Error> {
    let load_section = |id: gimli::SectionId| -> Result<R<'a>, gimli::Error> {
        let data = object
            .section_by_name(id.name())
            .and_then(|s| s.data().ok())
            .unwrap_or(&[]);
        Ok(EndianSlice::new(data, LittleEndian))
    };
    Dwarf::load(&load_section)
}

fn list_units(dwarf: &Dwarf<R>) -> Result<(), gimli::Error> {
    let mut units = dwarf.units();
    let mut idx = 0;
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let name = unit_name(dwarf, &unit).unwrap_or_else(|| "<unknown>".into());
        println!("[{}] offset=0x{:x} {}", idx, header.offset().as_debug_info_offset().unwrap().0, name);
        idx += 1;
    }
    println!("\nTotal: {} compilation units", idx);
    Ok(())
}

fn dump_all(dwarf: &Dwarf<R>, max_depth: usize) -> Result<(), gimli::Error> {
    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let name = unit_name(dwarf, &unit).unwrap_or_else(|| "<unknown>".into());
        println!("\n=== Unit: {} ===", name);

        let mut entries = unit.entries();
        let mut depth = 0isize;
        while let Some((delta, entry)) = entries.next_dfs()? {
            depth += delta;
            if max_depth > 0 && depth as usize > max_depth {
                continue;
            }
            print_die(dwarf, &unit, entry, depth as usize)?;
        }
    }
    Ok(())
}

fn search(dwarf: &Dwarf<R>, pattern: &str, check_linkage: bool) -> Result<(), gimli::Error> {
    let pattern_lower = pattern.to_lowercase();
    let mut count = 0;

    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let mut entries = unit.entries();

        while let Some((_, entry)) = entries.next_dfs()? {
            let mut matched = false;

            if let Some(name) = get_attr_string(dwarf, &unit, entry, DW_AT_name)? {
                if name.to_lowercase().contains(&pattern_lower) {
                    matched = true;
                }
            }

            if !matched && check_linkage {
                if let Some(name) = get_attr_string(dwarf, &unit, entry, DW_AT_linkage_name)? {
                    if name.to_lowercase().contains(&pattern_lower) {
                        matched = true;
                    }
                }
            }

            if matched {
                count += 1;
                println!("\n--- Match #{} ---", count);
                print_die(dwarf, &unit, entry, 0)?;
            }
        }
    }
    println!("\nFound {} matches", count);
    Ok(())
}

fn show_async(dwarf: &Dwarf<R>) -> Result<(), gimli::Error> {
    println!("=== Async-related DIEs ===\n");

    let async_patterns = ["{{closure}}", "{async", "Future", "__awaitee", "poll", "Pin<"];
    let mut count = 0;

    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let mut entries = unit.entries();

        while let Some((_, entry)) = entries.next_dfs()? {
            let name = get_attr_string(dwarf, &unit, entry, DW_AT_name)?;
            let linkage = get_attr_string(dwarf, &unit, entry, DW_AT_linkage_name)?;

            let is_async = name.as_ref().map_or(false, |n| {
                async_patterns.iter().any(|p| n.contains(p))
            }) || linkage.as_ref().map_or(false, |n| {
                async_patterns.iter().any(|p| n.contains(p))
            });

            // Also check for __awaitee member
            let has_awaitee = entry.attrs().any(|attr| {
                attr.map_or(false, |a| {
                    if let Some(name) = get_attr_string(dwarf, &unit, entry, a.name()).ok().flatten() {
                        name.contains("__awaitee")
                    } else {
                        false
                    }
                })
            });

            if is_async || has_awaitee {
                count += 1;
                println!("--- #{} ---", count);
                print_die_full(dwarf, &unit, entry)?;
                println!();
            }
        }
    }
    println!("Found {} async-related DIEs", count);
    Ok(())
}

fn show_vtables(dwarf: &Dwarf<R>) -> Result<(), gimli::Error> {
    println!("=== Vtables (DIEs with DW_AT_containing_type) ===\n");
    let mut count = 0;

    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let mut entries = unit.entries();

        while let Some((_, entry)) = entries.next_dfs()? {
            if let Ok(Some(attr)) = entry.attr(DW_AT_containing_type) {
                count += 1;
                println!("--- Vtable #{} ---", count);

                // Show vtable DIE
                print_die_full(dwarf, &unit, entry)?;

                // Try to resolve containing_type
                if let AttributeValue::UnitRef(offset) = attr.value() {
                    println!("  -> DW_AT_containing_type points to:");
                    if let Ok(Some(target)) = unit.entry(offset) {
                        print_die(dwarf, &unit, &target, 2)?;
                    }
                }
                println!();
            }
        }
    }
    println!("Found {} vtables", count);
    Ok(())
}

fn show_die(dwarf: &Dwarf<R>, offset_str: &str) -> Result<(), gimli::Error> {
    let offset = parse_hex(offset_str).expect("Invalid hex offset");

    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;

        // Try to find DIE at this offset within this unit
        let unit_offset = UnitOffset(offset);
        if let Ok(Some(entry)) = unit.entry(unit_offset) {
            println!("Found DIE at offset 0x{:x}:\n", offset);
            print_die_full(dwarf, &unit, &entry)?;

            // Also show children
            let mut entries = unit.entries_at_offset(unit_offset)?;
            let mut depth = 0isize;
            let mut first = true;
            while let Some((delta, child)) = entries.next_dfs()? {
                depth += delta;
                if first {
                    first = false;
                    continue; // Skip the entry itself
                }
                if depth <= 0 {
                    break;
                }
                print_die(dwarf, &unit, child, depth as usize)?;
            }
            return Ok(());
        }
    }
    println!("DIE not found at offset 0x{:x}", offset);
    Ok(())
}

fn show_types(dwarf: &Dwarf<R>, filter: Option<&str>) -> Result<(), gimli::Error> {
    println!("=== Types ===\n");
    let filter_lower = filter.map(|f| f.to_lowercase());

    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let mut entries = unit.entries();

        while let Some((_, entry)) = entries.next_dfs()? {
            let tag = entry.tag();
            if !matches!(
                tag,
                gimli::DW_TAG_structure_type
                    | gimli::DW_TAG_enumeration_type
                    | gimli::DW_TAG_union_type
                    | gimli::DW_TAG_typedef
            ) {
                continue;
            }

            let name = get_attr_string(dwarf, &unit, entry, DW_AT_name)?;

            if let Some(ref f) = filter_lower {
                if !name.as_ref().map_or(false, |n| n.to_lowercase().contains(f)) {
                    continue;
                }
            }

            print_die(dwarf, &unit, entry, 0)?;
        }
    }
    Ok(())
}

fn show_functions(dwarf: &Dwarf<R>, filter: Option<&str>) -> Result<(), gimli::Error> {
    println!("=== Functions ===\n");
    let filter_lower = filter.map(|f| f.to_lowercase());

    let mut units = dwarf.units();
    while let Some(header) = units.next()? {
        let unit = dwarf.unit(header)?;
        let mut entries = unit.entries();

        while let Some((_, entry)) = entries.next_dfs()? {
            if entry.tag() != gimli::DW_TAG_subprogram {
                continue;
            }

            let name = get_attr_string(dwarf, &unit, entry, DW_AT_name)?;
            let linkage = get_attr_string(dwarf, &unit, entry, DW_AT_linkage_name)?;

            if let Some(ref f) = filter_lower {
                let matches = name.as_ref().map_or(false, |n| n.to_lowercase().contains(f))
                    || linkage.as_ref().map_or(false, |n| n.to_lowercase().contains(f));
                if !matches {
                    continue;
                }
            }

            print_die(dwarf, &unit, entry, 0)?;
        }
    }
    Ok(())
}

// === Helper functions ===

fn print_die(
    dwarf: &Dwarf<R>,
    unit: &Unit<R>,
    entry: &DebuggingInformationEntry<R>,
    depth: usize,
) -> Result<(), gimli::Error> {
    let indent = "  ".repeat(depth);
    let offset = entry.offset().0;

    print!("{}<{:x}> {}", indent, offset, entry.tag());

    if let Some(name) = get_attr_string(dwarf, unit, entry, DW_AT_name)? {
        print!(" \"{}\"", name);
    }

    println!();
    Ok(())
}

fn print_die_full(
    dwarf: &Dwarf<R>,
    unit: &Unit<R>,
    entry: &DebuggingInformationEntry<R>,
) -> Result<(), gimli::Error> {
    println!("<{:x}> {}", entry.offset().0, entry.tag());

    let mut attrs = entry.attrs();
    while let Some(attr) = attrs.next()? {
        print!("    {}: ", attr.name());

        match attr.value() {
            AttributeValue::String(s) => println!("\"{}\"", s.to_string_lossy()?),
            AttributeValue::DebugStrRef(offset) => {
                if let Ok(s) = dwarf.string(offset) {
                    println!("\"{}\"", s.to_string_lossy()?);
                } else {
                    println!("<str@{:x}>", offset.0);
                }
            }
            AttributeValue::UnitRef(offset) => println!("<0x{:x}>", offset.0),
            AttributeValue::Udata(v) => println!("{}", v),
            AttributeValue::Sdata(v) => println!("{}", v),
            AttributeValue::Addr(v) => println!("0x{:x}", v),
            AttributeValue::Flag(v) => println!("{}", v),
            AttributeValue::Exprloc(expr) => {
                println!("<expr {} bytes>", expr.0.len());
            }
            AttributeValue::DebugLineRef(offset) => println!("<line@{:x}>", offset.0),
            other => println!("{:?}", other),
        }
    }
    Ok(())
}

fn get_attr_string<'a>(
    dwarf: &'a Dwarf<R<'a>>,
    unit: &Unit<R<'a>>,
    entry: &DebuggingInformationEntry<R<'a>>,
    attr_name: gimli::DwAt,
) -> Result<Option<String>, gimli::Error> {
    let attr = match entry.attr(attr_name)? {
        Some(a) => a,
        None => return Ok(None),
    };

    let s = match attr.value() {
        AttributeValue::String(s) => s.to_string_lossy()?.into_owned(),
        AttributeValue::DebugStrRef(offset) => {
            dwarf.string(offset)?.to_string_lossy()?.into_owned()
        }
        _ => return Ok(None),
    };
    Ok(Some(s))
}

fn unit_name<'a>(dwarf: &'a Dwarf<R<'a>>, unit: &Unit<R<'a>>) -> Option<String> {
    let mut entries = unit.entries();
    if let Ok(Some((_, entry))) = entries.next_dfs() {
        get_attr_string(dwarf, unit, entry, DW_AT_name).ok().flatten()
    } else {
        None
    }
}

fn parse_hex(s: &str) -> Option<usize> {
    let s = s.trim_start_matches("0x").trim_start_matches("0X");
    usize::from_str_radix(s, 16).ok()
}
