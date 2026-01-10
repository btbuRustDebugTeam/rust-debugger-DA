import re
import struct
import gdb

# -------------------------
# Settings
# -------------------------

MAX_CALLSITES_PER_FN = 200  # safety cap

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

def _info_symbol_raw(addr: int) -> str:
    return gdb.execute(f"info symbol {addr:#x}", to_string=True).strip()

def _info_symbol_name(addr: int) -> str:
    """
    Parse `info symbol` to get a bare symbol name.
    Examples:
      "foo + 0 in section .text of ..." -> "foo"
    """
    s = _info_symbol_raw(addr)
    s = s.split(" in section")[0].strip()
    s = s.split(" + ")[0].strip()
    return s

def _current_pc() -> int:
    return int(gdb.parse_and_eval("$pc"))

def _current_function_name() -> str:
    f = gdb.selected_frame()
    return f.name() or "<unknown>"

def _function_range() -> tuple[int, int] | None:
    """
    Get [start,end) range for current function using block ranges.
    This avoids parsing weird Rust names.
    """
    blk = gdb.selected_frame().block()
    while blk is not None and blk.function is None:
        blk = blk.superblock
    if blk is None:
        return None
    # blk.start/end are PCs
    if blk.start is None or blk.end is None:
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
    # disassemble a small window, take the instruction at pc
    insns = arch.disassemble(pc, pc + 16)
    for ins in insns:
        if int(ins["addr"]) == pc:
            return ins.get("asm", "")
    # fallback (rare)
    return gdb.execute("x/i $pc", to_string=True).strip()

HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")

def _resolve_call_target_from_asm(asm: str) -> int | None:
    """
    Supports typical AT&T syntax forms:
      - direct:   callq  0x401234 <sym>
      - indirect: callq  *%rax
      - indirect: callq  *0x18(%rax)
    """
    s = asm.strip()

    # direct call: has an immediate 0x... and is not "*0x..."
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
    """
    minimal::foo::{async_fn#0} -> minimal::foo::{async_fn_env#0}
    minimal::bar::{async_block#0} -> minimal::bar::{async_block_env#0}
    """
    s = poll_sym
    s = s.replace("{async_fn#", "{async_fn_env#")
    s = s.replace("{async_block#", "{async_block_env#")
    return s if s != poll_sym else None

def _try_read_awaitee_from_current_poll(poll_sym: str):
    """
    Return (awaitee_value_str, awaitee_type_str) or None.
    Assumes x86_64 SysV: first arg in $rdi points at env (works well at -O0).
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
        return (str(awaitee), str(awaitee.type))
    except gdb.error:
        return None

# -------------------------
# Breakpoints
# -------------------------

_CALLSITE_INSTALLED_FOR_FN = set()
_ACTIVE_POLL_BPS = set()

def _is_interesting_symbol(sym_name: str) -> bool:
    # keep permissive for now
    return ("::poll" in sym_name) or ("{async_fn#" in sym_name) or ("{async_block#" in sym_name)

class PollEntryBP(gdb.Breakpoint):
    """
    Breakpoint at poll-like function entry.
    On hit:
      1) read __awaitee (best-effort) and install child poll-entry BP if it's async_fn_env
      2) install call-site breakpoints for this function (once)
      3) auto-continue
    """
    def __init__(self, location: str, poll_sym: str | None = None, internal: bool = False, temporary: bool = False):
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=internal, temporary=temporary)
        self.silent = True
        self.poll_sym = poll_sym

    def stop(self) -> bool:
        fn = _current_function_name()
        gdb.write(f"[ARD] poll-entry hit: {fn}\n")

        # read __awaitee
        if self.poll_sym:
            awa = _try_read_awaitee_from_current_poll(self.poll_sym)
            if awa is not None:
                awa_val, awa_ty = awa
                gdb.write(f"[ARD]   __awaitee type = {awa_ty}\n")
                gdb.write(f"[ARD]   __awaitee val  = {awa_val}\n")

                # If it's an async env, pre-install its poll-entry by name
                if "{async_fn_env#" in awa_ty:
                    child_poll = awa_ty.replace("{async_fn_env#", "{async_fn#")
                    if child_poll not in _ACTIVE_POLL_BPS:
                        _ACTIVE_POLL_BPS.add(child_poll)
                        PollEntryBP(child_poll, poll_sym=child_poll, internal=False)
                        gdb.write(f"[ARD]   installed child poll-entry BP: {child_poll}\n")

        # install call-site breakpoints once per function
        if fn not in _CALLSITE_INSTALLED_FOR_FN:
            try:
                call_sites = _collect_call_sites()
            except gdb.error as e:
                gdb.write(f"[ARD]   call-site scan failed: {e}\n")
                return False

            for a in call_sites:
                CallSiteBP(a, internal=True)

            _CALLSITE_INSTALLED_FOR_FN.add(fn)
            gdb.write(f"[ARD]   installed {len(call_sites)} call-site BP(s) for {fn}\n")

        return False  # keep running


class CallSiteBP(gdb.Breakpoint):
    """
    Breakpoint at a call instruction address.
    On hit:
      - resolve call target
      - if target symbol looks interesting, set a one-shot BP at callee entry
      - auto-continue
    """
    def __init__(self, addr: int, internal: bool = True):
        super().__init__(f"*{addr:#x}", type=gdb.BP_BREAKPOINT, internal=internal)
        self.silent = True
        self.addr = addr

    def stop(self) -> bool:
        asm = _current_asm()
        target = _resolve_call_target_from_asm(asm)
        if not target:
            return False

        sym_name = _info_symbol_name(target)
        if _is_interesting_symbol(sym_name):
            # break at callee entry (temporary)
            try:
                PollEntryBP(f"*{target:#x}", poll_sym=sym_name, internal=True, temporary=True)
                gdb.write(f"[ARD] call-site {self.addr:#x} -> {target:#x}  ({sym_name})\n")
            except Exception as e:
                gdb.write(f"[ARD] failed to set callee BP: {e}\n")
            gdb.write(f"[ARD] call-site {self.addr:#x} -> {target:#x}  ({sym_name})\n")

        return False


# -------------------------
# Public command
# -------------------------

class ARDTraceCommand(gdb.Command):
    """
    ardb-trace <poll-symbol>
      Example:
        (gdb) ardb-trace minimal::nonleaf::{async_fn#0}
        (gdb) run
    """
    def __init__(self):
        super().__init__("ardb-trace", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        arg = arg.strip()
        if not arg:
            gdb.write("Usage: ardb-trace <poll-symbol>\n")
            return

        gdb.execute("set pagination off", to_string=True)
        gdb.execute("set debuginfod enabled off", to_string=True)

        if arg not in _ACTIVE_POLL_BPS:
            _ACTIVE_POLL_BPS.add(arg)
            PollEntryBP(arg, poll_sym=arg, internal=False)
            gdb.write(f"[ARD] installed root poll-entry BP: {arg}\n")
        else:
            gdb.write(f"[ARD] root BP already installed: {arg}\n")


def install():
    gdb.execute("set pagination off", to_string=True)
    gdb.execute("set debuginfod enabled off", to_string=True)
    ARDTraceCommand()
    gdb.write("[ARD] runtime_trace installed. Use: ardb-trace <poll-symbol>\n")
