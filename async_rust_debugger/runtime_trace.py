import os
import re
import struct
import gdb

# -------------------------
# User-facing knobs
# -------------------------

MAX_CALLSITES_PER_FN = 200
PRINT_INTERNAL_POLL_HITS = True
PRINT_WHITELIST_ADDR_STATS = True

# -------------------------
# Coroutine instance tracking (runtime)
# -------------------------

_CO_NEXT_ID = 1
_CO_BY_KEY = {}      # (poll_sym, this_ptr) -> coro_id
_CO_META = {}        # coro_id -> (poll_sym, this_ptr)
_TLS_STACK = {}      # thread_num -> [coro_id, ...]

def _thread_id() -> int:
    t = gdb.selected_thread()
    return t.num if t is not None else 0

def _get_or_make_coro_id(poll_sym: str, this_ptr: int) -> int:
    global _CO_NEXT_ID
    key = (poll_sym, int(this_ptr))
    cid = _CO_BY_KEY.get(key)
    if cid is None:
        cid = _CO_NEXT_ID
        _CO_NEXT_ID += 1
        _CO_BY_KEY[key] = cid
        _CO_META[cid] = key
        gdb.write(f"[ARD] coro#{cid} new: {poll_sym} @ {this_ptr:#x}\n")
    return cid

def _push_coro(cid: int) -> int:
    tid = _thread_id()
    st = _TLS_STACK.setdefault(tid, [])
    st.append(cid)
    return len(st) - 1  # depth

def _current_coro():
    tid = _thread_id()
    st = _TLS_STACK.get(tid, [])
    return (st[-1], len(st) - 1) if st else (0, -1)

class _PopOnReturnBP(gdb.FinishBreakpoint):
    """Pop coroutine stack when current function returns."""
    def __init__(self, tid: int, cid: int):
        super().__init__(gdb.selected_frame(), internal=True)
        self.silent = True
        self.tid = tid
        self.cid = cid
        _RUN_SCOPED_BPS.append(self)

    def stop(self):
        st = _TLS_STACK.get(self.tid, [])
        if not st:
            return False

        if st[-1] == self.cid:
            st.pop()
            return False

        # fallback: remove from back if mismatch
        for i in range(len(st) - 1, -1, -1):
            if st[i] == self.cid:
                del st[i]
                break
        return False

# -------------------------
# State
# -------------------------

_CREATED_BPS = []
_RUN_SCOPED_BPS = []

_CALLSITE_INSTALLED_FOR_FN = set()   # per-run: avoid re-installing callsite BPs
_ACTIVE_ROOTS = set()                # symbol roots/children installed (symbol BPs)

_WHITELIST = None                    # set[str] | None
_WHITELIST_PATH = None

_WHITELIST_ADDR_MAP = {}             # per-run: addr -> canonical whitelist symbol
_WHITELIST_ADDR_READY = False

_EVENTS_INSTALLED = False

# -------------------------
# Low-level helpers
# -------------------------

CALL_MNEMONIC_RE = re.compile(r"^\s*call\w*\b", re.IGNORECASE)
HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")

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
    s = _info_symbol_raw(addr)
    s = s.split(" in section")[0].strip()
    s = s.split(" + ")[0].strip()
    return s

def _find_pc_function_name(addr: int) -> str | None:
    try:
        sym = gdb.find_pc_function(addr)
        if sym is None:
            return None
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
    blk = gdb.selected_frame().block()
    while blk is not None and blk.function is None:
        blk = blk.superblock
    if blk is None or blk.start is None or blk.end is None:
        return None
    return (int(blk.start), int(blk.end))

def _collect_call_sites() -> list[int]:
    r = _function_range()
    if r is None:
        raise gdb.error("cannot get function range")
    start, end = r
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(start, end)

    out = []
    seen = set()
    for ins in insns:
        asm = ins.get("asm", "").strip()
        if CALL_MNEMONIC_RE.match(asm):
            a = int(ins["addr"])
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

def _resolve_call_target_from_asm(asm: str) -> int | None:
    s = asm.strip()

    # direct call
    if "call" in s and "0x" in s and "*0x" not in s:
        m = HEX_ADDR_RE.search(s)
        if m:
            return int(m.group(1), 16)

    # call *%reg
    m = re.search(r"call\w*\s+\*\%([a-z0-9]+)\b", s)
    if m:
        return _reg_u64(m.group(1))

    # call *disp(%reg)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%([a-z0-9]+)\)", s)
    if m:
        disp_s, base = m.group(1), m.group(2)
        disp = int(disp_s, 16) if disp_s.startswith(("0x", "-0x")) else int(disp_s, 10)
        slot = _reg_u64(base) + disp
        return _read_ptr(slot)

    # NOTE: 没处理 *disp(%rip)
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
# Whitelist (PIE/ASLR-safe via per-run addr map)
# -------------------------

def _default_whitelist_path() -> str | None:
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(temp_dir, "poll_functions.txt")

def _load_whitelist_file(path: str) -> set[str]:
    syms: set[str] = set()
    with open(path, "r", encoding="utf-8") as fp:
        for raw in fp:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 2 and parts[0].isdigit():
                syms.add(parts[1])
            else:
                syms.add(line)
    return syms

def _invalidate_whitelist_addrs():
    global _WHITELIST_ADDR_MAP, _WHITELIST_ADDR_READY
    _WHITELIST_ADDR_MAP = {}
    _WHITELIST_ADDR_READY = False

def _try_addr_by_lookup_global_symbol(name: str) -> int | None:
    try:
        sym = gdb.lookup_global_symbol(name)
        if sym is None:
            return None
        v = sym.value()
        voidp = gdb.lookup_type("void").pointer()
        return int(v.cast(voidp))
    except Exception:
        return None

def _try_addr_by_info_address(name: str) -> int | None:
    for expr in (name, f"'{name}'"):
        try:
            out = gdb.execute(f"info address {expr}", to_string=True)
        except gdb.error:
            continue
        m = HEX_ADDR_RE.search(out)
        if m:
            return int(m.group(1), 16)
    return None

def _build_whitelist_addr_map_if_needed(caller_is_user_visible: bool):
    global _WHITELIST_ADDR_READY, _WHITELIST_ADDR_MAP
    if _WHITELIST is None or _WHITELIST_ADDR_READY:
        return

    resolved = 0
    total = len(_WHITELIST)
    addr_map = {}

    for name in _WHITELIST:
        addr = _try_addr_by_lookup_global_symbol(name)
        if addr is None:
            addr = _try_addr_by_info_address(name)
        if addr is None:
            continue
        addr_map[int(addr)] = name
        resolved += 1

    _WHITELIST_ADDR_MAP = addr_map
    _WHITELIST_ADDR_READY = True

    if caller_is_user_visible and PRINT_WHITELIST_ADDR_STATS:
        gdb.write(f"[ARD] whitelist addrs: {resolved}/{total} resolved (PIE/ASLR-safe)\n")

def _whitelist_allows_by_addr(target_addr: int) -> str | None:
    if _WHITELIST is None or not _WHITELIST_ADDR_READY:
        return None
    return _WHITELIST_ADDR_MAP.get(int(target_addr))

# -------------------------
# Callee selection
# -------------------------

def _is_pollish_name(sym_name: str) -> bool:
    return ("::poll" in sym_name) or ("{async_fn#" in sym_name) or ("{async_block#" in sym_name)

def _callee_candidates(addr: int) -> list[str]:
    cands = []
    n1 = _find_pc_function_name(addr)
    if n1:
        cands.append(n1.strip())
    n2 = _info_symbol_name(addr)
    if n2:
        cands.append(n2.strip())
    seen = set()
    out = []
    for s in cands:
        if s and s not in seen:
            out.append(s)
            seen.add(s)
    return out

def _pick_interesting_callee(target_addr: int) -> str | None:
    # If whitelist loaded and addr-map ready: strict by address
    if _WHITELIST is not None and _WHITELIST_ADDR_READY:
        return _whitelist_allows_by_addr(target_addr)

    # addr-map not ready yet: try name membership
    cands = _callee_candidates(target_addr)
    if _WHITELIST is not None:
        for n in cands:
            if n in _WHITELIST:
                return n
        return None

    # no whitelist: heuristic
    for n in cands:
        if _is_pollish_name(n):
            return n
    return None

# -------------------------
# Run-scoped cleanup (PIE/ASLR safe)
# -------------------------

def _cleanup_run_scoped():
    for bp in list(_RUN_SCOPED_BPS):
        try:
            bp.delete()
        except Exception:
            pass
    _RUN_SCOPED_BPS.clear()

    _CALLSITE_INSTALLED_FOR_FN.clear()
    _invalidate_whitelist_addrs()

    _TLS_STACK.clear()
    _CO_BY_KEY.clear()
    _CO_META.clear()
    global _CO_NEXT_ID
    _CO_NEXT_ID = 1

def _on_exited(event):
    _cleanup_run_scoped()

def _on_new_objfile(event):
    _cleanup_run_scoped()

# -------------------------
# Breakpoints
# -------------------------

class PollEntryBP(gdb.Breakpoint):
    def __init__(self, location: str, poll_sym: str | None, internal: bool, temporary: bool = False):
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=internal, temporary=temporary)
        self.silent = True
        self.poll_sym = poll_sym or ""
        self.internal = internal
        _CREATED_BPS.append(self)

        if isinstance(location, str) and location.strip().startswith("*"):
            _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        fn = _current_function_name()

        # ---- coro context enter (best-effort) ----
        tid = _thread_id()
        try:
            this_ptr = _reg_u64("rdi")   # x86_64 SysV: first arg
        except Exception:
            this_ptr = 0

        poll_sym = self.poll_sym or fn
        cid = 0
        depth = -1
        if poll_sym and this_ptr:
            cid = _get_or_make_coro_id(poll_sym, this_ptr)
            depth = _push_coro(cid)
            _PopOnReturnBP(tid, cid)

        indent = "  " * max(depth, 0)

        _build_whitelist_addr_map_if_needed(caller_is_user_visible=(not self.internal))

        # poll line
        if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
            gdb.write(f"[ARD]{indent} poll[coro#{cid}] {fn}\n")

        # awaitee line (no dedup)
        if self.poll_sym:
            awa = _try_read_awaitee_from_current_poll(self.poll_sym)
            if awa is not None:
                awa_ty, _awa_val = awa
                gdb.write(f"[ARD]{indent} awa[coro#{cid}] {fn} -> {awa_ty}\n")

                child_poll = _child_poll_symbol_from_awaitee_type(awa_ty)
                if child_poll and (child_poll not in _ACTIVE_ROOTS):
                    if _WHITELIST is None or child_poll in _WHITELIST:
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
    def __init__(self, addr: int):
        super().__init__(f"*{addr:#x}", type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.addr = addr
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        target = _resolve_call_target_from_asm(_current_asm())
        if not target:
            return False

        callee = _pick_interesting_callee(target)
        if not callee:
            return False

        caller = _current_function_name()
        cid, depth = _current_coro()
        indent = "  " * max(depth, 0)

        # call line (no dedup)
        gdb.write(f"[ARD]{indent} call[coro#{cid}] {caller} -> {callee}\n")

        # IMPORTANT: 不要再装 *addr 的临时 PollEntryBP，避免和已有 symbol BP 双重命中
        # 改成：若还没追踪过该 poll symbol，就按“符号名”装一个（只装一次）
        if callee not in _ACTIVE_ROOTS:
            # whitelist 模式下仍然只会进到这里（callee 已经通过 _pick_interesting_callee 过滤）
            _ACTIVE_ROOTS.add(callee)
            PollEntryBP(callee, poll_sym=callee, internal=True, temporary=False)

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

        if sym in _ACTIVE_ROOTS:
            gdb.write(f"[ARD] root already traced: {sym}\n")
            return

        if _WHITELIST is not None and sym not in _WHITELIST:
            gdb.write(f"[ARD] warning: root not in whitelist: {sym}\n")

        _ACTIVE_ROOTS.add(sym)
        PollEntryBP(sym, poll_sym=sym, internal=False, temporary=False)
        gdb.write(f"[ARD] trace root: {sym}\n")

class ARDResetCommand(gdb.Command):
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

        _invalidate_whitelist_addrs()

        _TLS_STACK.clear()
        _CO_BY_KEY.clear()
        _CO_META.clear()
        global _CO_NEXT_ID
        _CO_NEXT_ID = 1

        gdb.write("[ARD] reset done.\n")

class ARDLoadWhitelistCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-load-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _WHITELIST, _WHITELIST_PATH
        path = arg.strip() or _default_whitelist_path()
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
        _invalidate_whitelist_addrs()
        gdb.write(f"[ARD] whitelist loaded: {len(wl)} symbols from {path}\n")

class ARDGenWhitelistCommand(gdb.Command):
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
