# developer notes

> suppose one type exists in multiple compilation units, are they ALWAYS the same thing?

**Yes, for the same type name in the same crate, they represent the same logical type.** Rust guarantees type identity within a crate.

However, there are subtle differences in what DWARF might contain:

## What's Guaranteed Identical

- Type layout (size, alignment, field offsets)
- Field names and types
- Enum discriminant values
- The semantic meaning

## What Might Differ Between CGUs

| Aspect | Can Differ? | Why |
|--------|-------------|-----|
| DIE offset | ✅ Yes | Different position in debug info |
| Inlined function instances | ✅ Yes | Each CGU has its own inlined copies |
| Line number info | ✅ Yes | Different source mappings |
| Whether type is complete or forward-declared | ✅ Yes | CGU might only need forward decl |
| Optimized-out fields | ✅ Yes | If field unused in that CGU |

## Practical Implications for Your Debugger

```python
# Safe: Use any instance for type layout
def get_async_future_layout(type_name):
    # GDB will give you consistent layout regardless of which CGU
    t = gdb.lookup_type(type_name)
    return t.sizeof, [(f.name, f.bitpos // 8) for f in t.fields()]

# Careful: DIE offsets are CGU-specific
# Don't cache DIE offsets across types from different CGUs
```

## Edge Cases to Watch

1. **Generic instantiations**: `Vec<i32>` in CGU1 and CGU2 are the same, but `Vec<i32>` vs `Vec<i64>` are different types (different mangled names anyway)

2. **Cross-crate types**: If you see `core::pin::Pin<&mut T>` in multiple CGUs, they're identical—but the `T` parameter determines which instantiation

3. **Optimized builds**: Some CGUs might have more complete debug info than others depending on what code was actually used there

## Recommendation

For your debugger, **deduplicate by type name** and pick any CGU's instance:

```python
def get_unique_async_types():
    output = gdb.execute("info types async_fn_env", to_string=True)
    seen = {}
    for line in output.splitlines():
        name = line.strip()
        if name and not name.startswith(("File ", "All ", "--")):
            # Keep first occurrence, all are equivalent
            if name not in seen:
                seen[name] = gdb.lookup_type(name)
    return seen
```