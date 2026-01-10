import os
import re
import struct
import gdb

# -------------------------
# User-facing knobs
# -------------------------

MAX_CALLSITES_PER_FN = 200          # safety cap per function
PRINT_INTERNAL_POLL_HITS = False    # keep output readable

# -------------------------
# Internal state
# -------------------------

_CREATED_BPS = []                  # all breakpoints created by this script
_RUN_SCOPED_BPS = []               # address-based breakpoints (invalid across runs)
_CALLSITE_INSTALLED_FOR_FN = set() # function names we've scanned (per run)
_ACTIVE_ROOTS = set()              # root/child poll symbols installed (symbol BPs)
_SEEN_CALL_EDGES = set()           # (caller_fn, callee_sym) printed edges (per run)

_WHITELIST = None                  # set[str] or None
_WHITELIST_PATH = None             # str or None

_EVENTS_INSTALLED = False

# -------------------------
# Utilities
# -------------------------

def _ptr_size() -> int:
    return gdb.lookup_type("void").pointer().sizeof

def _read_ptr(addr: int) -> int:
    inf = gdb.selected_inferior()
    ps = _ptr_size()
    mem = inf.read_memory(addr, ps).tobytes()
    if ps == 8:
        return struct.unpack("<Q", mem)[0]
    return struct.unpack("<I", mem)[0]

def _reg_u64(name: str) -> int:
    return int(gdb.parse_and_eval(f"${name}"))

def _current_pc() -> int:
    return int(gdb.parse_and_eval("$pc"))

def _current_function_name() -> str:
    f = gdb.selected_frame()
    return f.name() or "<unknown>"

def _info_symbol_raw(addr: int) -> str:
    return gdb.execute(f"info symbol {addr:#x}", to_string=True).strip()

def _info_symbol_name(addr: int) -> str:
    """
    Parse `info symbol` to get a bare symbol name.
    """
    s = _info_symbol_raw(addr)
    s = s.split(" in section")[0].strip()
    s = s.split(" + ")[0].strip()
    return s

def _find_pc_function_name(addr: int) -> str | None:
    """
    Prefer GDB's pc->function mapping; often matches 'info functions' naming better.
    """
    try:
        sym = gdb.find_pc_function(addr)
        if sym is None:
            return None
        # Some GDB builds provide print_name; others only name.
        n = getattr(sym, "print_name", None)
        if n:
            return str(n)
        n2 = getattr(sym, "name", None)
        if n2:
            return str(n2)
        return str(sym)
    except Exception:
        return None

def _function_range() -> tuple[int, int] | None:
    """
    Get [start,end) range for current function using block ranges.
    Avoids parsing weird Rust names like {async_fn#0}.
    """
    blk = gdb.selected_frame().block()
    while blk is not None and blk.function is None:
        blk = blk.superblock
    if blk is None or blk.start is None or blk.end is None:
        return None
    return (int(blk.start), int(blk.end))

CALL_MNEMONIC_RE = re.compile(r"^\s*call\w*\b", re.IGNORECASE)

def _collect_call_sites() -> list[int]:
    r = _function_range()
    if r is None:
        raise gdb.error("cannot get function range")
    start, end = r
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(start, end)
    addrs = []
    for ins in insns:
        asm = ins.get("asm", "")
        if CALL_MNEMONIC_RE.match(asm.strip()):
            addrs.append(int(ins["addr"]))
    # de-dup preserve order
    seen = set()
    out = []
    for a in addrs:
        if a not in seen:
            out.append(a)
            seen.add(a)
    return out[:MAX_CALLSITES_PER_FN]

def _current_asm() -> str:
    pc = _current_pc()
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(pc, pc + 16)
    for ins in insns:
        if int(ins["addr"]) == pc:
            return ins.get("asm", "")
    return gdb.execute("x/i $pc", to_string=True).strip()

HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")

def _resolve_call_target_from_asm(asm: str) -> int | None:
    """
    Supports typical AT&T syntax:
      - direct:   callq  0x401234 <sym>
      - indirect: callq  *%rax
      - indirect: callq  *0x18(%rax)
    """
    s = asm.strip()

    # direct call: has immediate 0x... and not "*0x..."
    if "call" in s and "0x" in s and "*0x" not in s:
        m = HEX_ADDR_RE.search(s)
        if m:
            return int(m.group(1), 16)

    # call *%reg
    m = re.search(r"call\w*\s+\*\%([a-z0-9]+)\b", s)
    if m:
        reg = m.group(1)
        return _reg_u64(reg)

    # call *disp(%reg)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%([a-z0-9]+)\)", s)
    if m:
        disp_s = m.group(1)
        base = m.group(2)
        disp = int(disp_s, 16) if disp_s.startswith("0x") or disp_s.startswith("-0x") else int(disp_s, 10)
        basev = _reg_u64(base)
        slot = basev + disp
        return _read_ptr(slot)

    return None

# -------------------------
# __awaitee extraction (best-effort)
# -------------------------

def _pollsym_to_envtype(poll_sym: str) -> str | None:
    s = poll_sym
    s = s.replace("{async_fn#", "{async_fn_env#")
    s = s.replace("{async_block#", "{async_block_env#")
    return s if s != poll_sym else None

def _try_read_awaitee_from_current_poll(poll_sym: str):
    """
    Return (awaitee_type_str, awaitee_value_str) or None.
    Assumes x86_64 SysV: first arg in $rdi points at env (often true at -O0).
    """
    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        return None

    try:
        env_t = gdb.lookup_type(env_type_name)
    except gdb.error:
        return None

    env_ptr = _reg_u64("rdi")
    if env_ptr == 0:
        return None

    try:
        env_val = gdb.Value(env_ptr).cast(env_t.pointer()).dereference()
        state = int(env_val["__state"])
    except gdb.error:
        return None

    variant_map = {}
    for f in env_t.fields():
        if f.name is not None and re.fullmatch(r"\d+", str(f.name)):
            variant_map[int(f.name)] = f.type

    vt = variant_map.get(state)
    if vt is None:
        return None

    try:
        payload = env_val.address.cast(vt.pointer()).dereference()
        awaitee = payload["__awaitee"]
        return (str(awaitee.type), str(awaitee))
    except gdb.error:
        return None

def _child_poll_symbol_from_awaitee_type(awa_ty: str) -> str | None:
    if "{async_fn_env#" in awa_ty:
        return awa_ty.replace("{async_fn_env#", "{async_fn#")
    if "{async_block_env#" in awa_ty:
        return awa_ty.replace("{async_block_env#", "{async_block#")
    return None

# -------------------------
# Whitelist (poll targets)
# -------------------------

def _default_whitelist_path() -> str | None:
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(temp_dir, "poll_functions.txt")

def _load_whitelist_file(path: str) -> set[str]:
    """
    Accepts:
      - one symbol per line
      - or lines like: "0 minimal::foo::{async_fn#0}"
    """
    syms: set[str] = set()
    with open(path, "r", encoding="utf-8") as fp:
        for raw in fp:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 2 and parts[0].isdigit():
                sym = parts[1]
            else:
                sym = line
            syms.add(sym)
    return syms

def _whitelist_allows(sym: str) -> bool:
    global _WHITELIST
    if _WHITELIST is None:
        return True
    return sym in _WHITELIST

# -------------------------
# Filtering
# -------------------------

def _is_pollish_name(sym_name: str) -> bool:
    return ("::poll" in sym_name) or ("{async_fn#" in sym_name) or ("{async_block#" in sym_name)

def _callee_candidates(addr: int) -> list[str]:
    """
    Produce multiple naming spellings for the same address, because:
      - whitelist uses "info functions" style (e.g. minimal::{impl#0}::poll)
      - info symbol may return "<T as Trait>::poll"
    We try both and let whitelist match any.
    """
    cands = []
    n1 = _find_pc_function_name(addr)
    if n1:
        cands.append(n1.strip())
    n2 = _info_symbol_name(addr)
    if n2:
        cands.append(n2.strip())

    # de-dup keep order
    seen = set()
    out = []
    for s in cands:
        if s and s not in seen:
            out.append(s)
            seen.add(s)
    return out

def _pick_interesting_callee(addr: int) -> str | None:
    for name in _callee_candidates(addr):
        if _is_pollish_name(name) and _whitelist_allows(name):
            return name
    # if whitelist not loaded, allow heuristic match
    if _WHITELIST is None:
        for name in _callee_candidates(addr):
            if _is_pollish_name(name):
                return name
    return None

# -------------------------
# Run-scoped cleanup (ASLR/PIE safe)
# -------------------------

def _cleanup_run_scoped(reason: str):
    # delete address-based bps (call-sites + *addr entry bps)
    for bp in list(_RUN_SCOPED_BPS):
        try:
            bp.delete()
        except Exception:
            pass
    _RUN_SCOPED_BPS.clear()

    # per-run caches
    _CALLSITE_INSTALLED_FOR_FN.clear()
    _SEEN_CALL_EDGES.clear()

def _on_exited(event):
    _cleanup_run_scoped("exited")

def _on_new_objfile(event):
    # When a new objfile is loaded (common across re-run), old absolute addresses are stale.
    _cleanup_run_scoped("new_objfile")

# -------------------------
# Breakpoints
# -------------------------

class PollEntryBP(gdb.Breakpoint):
    """
    Breakpoint at poll-like function entry.
    internal=False: user-visible root breakpoint
    internal=True : auto-installed helper breakpoint
    """
    def __init__(self, location: str, poll_sym: str | None, internal: bool, temporary: bool = False):
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=internal, temporary=temporary)
        self.silent = True
        self.poll_sym = poll_sym or ""
        self.internal = internal
        _CREATED_BPS.append(self)

        # Address-based breakpoint => run-scoped
        try:
            if isinstance(location, str) and location.strip().startswith("*"):
                _RUN_SCOPED_BPS.append(self)
        except Exception:
            pass

    def stop(self) -> bool:
        fn = _current_function_name()

        # Print poll hits only for user-visible roots by default
        if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
            gdb.write(f"[ARD] poll: {fn}\n")

        # __awaitee chain
        if self.poll_sym:
            awa = _try_read_awaitee_from_current_poll(self.poll_sym)
            if awa is not None:
                awa_ty, _awa_val = awa

                if self.internal and not PRINT_INTERNAL_POLL_HITS:
                    gdb.write(f"[ARD]   awaitee@{fn}: {awa_ty}\n")
                else:
                    gdb.write(f"[ARD]   awaitee: {awa_ty}\n")

                child_poll = _child_poll_symbol_from_awaitee_type(awa_ty)
                if child_poll and (child_poll not in _ACTIVE_ROOTS):
                    # If whitelist is loaded, only follow into children we actually care about.
                    if _WHITELIST is None or _whitelist_allows(child_poll):
                        _ACTIVE_ROOTS.add(child_poll)
                        PollEntryBP(child_poll, poll_sym=child_poll, internal=True, temporary=False)

        # Install call-site breakpoints once per function (per run)
        if fn not in _CALLSITE_INSTALLED_FOR_FN:
            try:
                call_sites = _collect_call_sites()
            except gdb.error as e:
                if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                    gdb.write(f"[ARD]   call-site scan failed: {e}\n")
                return False

            for a in call_sites:
                CallSiteBP(a)

            _CALLSITE_INSTALLED_FOR_FN.add(fn)
            if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                gdb.write(f"[ARD]   call-sites: {len(call_sites)}\n")

        return False


class CallSiteBP(gdb.Breakpoint):
    """
    Breakpoint at a call instruction address (internal, quiet, run-scoped).
    On hit:
      - resolve call target
      - if interesting (and whitelist allows), set a one-shot poll-entry breakpoint at callee entry
      - print the edge once per run
    """
    def __init__(self, addr: int):
        super().__init__(f"*{addr:#x}", type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.addr = addr
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        asm = _current_asm()
        target = _resolve_call_target_from_asm(asm)
        if not target:
            return False

        callee = _pick_interesting_callee(target)
        if not callee:
            return False

        # Set a one-shot entry breakpoint at the callee (address-based => run-scoped)
        PollEntryBP(f"*{target:#x}", poll_sym=callee, internal=True, temporary=True)

        caller = _current_function_name()
        edge = (caller, callee)
        if edge not in _SEEN_CALL_EDGES:
            _SEEN_CALL_EDGES.add(edge)
            gdb.write(f"[ARD]   call@{caller} -> {callee}\n")

        return False

# -------------------------
# Commands
# -------------------------

class ARDTraceCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-trace", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        sym = arg.strip()
        if not sym:
            gdb.write("Usage: ardb-trace <poll-symbol>\n")
            return

        gdb.execute("set pagination off", to_string=True)
        gdb.execute("set debuginfod enabled off", to_string=True)

        if sym not in _ACTIVE_ROOTS:
            # If whitelist is loaded, help user catch typos early.
            if _WHITELIST is not None and sym not in _WHITELIST:
                gdb.write(f"[ARD] warning: root not in whitelist: {sym}\n")
            _ACTIVE_ROOTS.add(sym)
            PollEntryBP(sym, poll_sym=sym, internal=False, temporary=False)
            gdb.write(f"[ARD] trace root: {sym}\n")
        else:
            gdb.write(f"[ARD] root already traced: {sym}\n")


class ARDResetCommand(gdb.Command):
    """
    ardb-reset
      Delete ALL breakpoints created by this script and clear state.
      (Whitelist remains loaded.)
    """
    def __init__(self):
        super().__init__("ardb-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        for bp in list(_CREATED_BPS):
            try:
                bp.delete()
            except Exception:
                pass
        _CREATED_BPS.clear()
        _RUN_SCOPED_BPS.clear()

        _CALLSITE_INSTALLED_FOR_FN.clear()
        _ACTIVE_ROOTS.clear()
        _SEEN_CALL_EDGES.clear()

        gdb.write("[ARD] reset done.\n")


class ARDLoadWhitelistCommand(gdb.Command):
    """
    ardb-load-whitelist [path]
    Default path:
      $ASYNC_RUST_DEBUGGER_TEMP_DIR/poll_functions.txt
    """
    def __init__(self):
        super().__init__("ardb-load-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _WHITELIST, _WHITELIST_PATH
        path = arg.strip()
        if not path:
            path = _default_whitelist_path()
            if not path:
                gdb.write("[ARD] whitelist path not provided and ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n")
                return

        try:
            wl = _load_whitelist_file(path)
        except Exception as e:
            gdb.write(f"[ARD] failed to load whitelist: {e}\n")
            return

        _WHITELIST = wl
        _WHITELIST_PATH = path
        gdb.write(f"[ARD] whitelist loaded: {len(wl)} symbols from {path}\n")


class ARDGenWhitelistCommand(gdb.Command):
    """
    ardb-gen-whitelist
      Convenience wrapper around async_rust_debugger.static_analysis.gen_whitelist.gen_default_whitelist().
    """
    def __init__(self):
        super().__init__("ardb-gen-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            from async_rust_debugger.static_analysis.gen_whitelist import gen_default_whitelist
        except Exception as e:
            gdb.write(f"[ARD] cannot import gen_whitelist: {e}\n")
            return
        try:
            gen_default_whitelist()
        except Exception as e:
            gdb.write(f"[ARD] gen_default_whitelist failed: {e}\n")

# -------------------------
# Entry
# -------------------------

def install():
    global _EVENTS_INSTALLED
    gdb.execute("set pagination off", to_string=True)
    gdb.execute("set debuginfod enabled off", to_string=True)

    ARDTraceCommand()
    ARDResetCommand()
    ARDLoadWhitelistCommand()
    ARDGenWhitelistCommand()

    # Install event handlers once: fix PIE/ASLR address churn across runs
    if not _EVENTS_INSTALLED:
        try:
            gdb.events.exited.connect(_on_exited)
        except Exception:
            pass
        try:
            gdb.events.new_objfile.connect(_on_new_objfile)
        except Exception:
            pass
        _EVENTS_INSTALLED = True

    gdb.write("[ARD] installed. Commands: ardb-trace, ardb-reset, ardb-load-whitelist, ardb-gen-whitelist\n")
