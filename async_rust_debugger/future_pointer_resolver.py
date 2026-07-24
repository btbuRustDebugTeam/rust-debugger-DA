"""Resolve the Future environment pointer from the target ABI.

This module deliberately has no dependency on GDB's global state.  The caller
supplies the stopped frame, which makes the resolver independently testable and
keeps CID, TLS, poll, history, and Snapshot ownership in runtime_trace.py.
"""

from typing import NamedTuple, Optional


class FuturePointerResult(NamedTuple):
    address: Optional[int]
    register_source: Optional[str]
    confidence: str


_UNRESOLVED = FuturePointerResult(None, None, "none")


class FuturePointerResolver:
    """Read the first pointer argument using an explicit target ABI map."""

    _ABI_BY_ARCHITECTURE = {
        # System V AMD64 ABI.
        "i386:x86-64": ("rdi", 64),
        # RISC-V LP64 ABI. GDB exposes x10 by its ABI name, a0.
        "riscv:rv64": ("a0", 64),
        # Cortex-M targets use AAPCS32. Local thumbv7m GDB reports armv7.
        "armv6-m": ("r0", 32),
        "armv7": ("r0", 32),
        "armv7-m": ("r0", 32),
        "armv7e-m": ("r0", 32),
        "armv8-m.base": ("r0", 32),
        "armv8-m.main": ("r0", 32),
    }

    @classmethod
    def resolve(cls, frame) -> FuturePointerResult:
        """Return an ABI-sourced address, or an unresolved result.

        There is intentionally no alternate-register, memory, field, or
        pointer-range fallback. A missing architecture/register and address 0
        are all hard failures.
        """
        try:
            architecture = frame.architecture().name()
        except Exception:
            return _UNRESOLVED

        abi = cls._ABI_BY_ARCHITECTURE.get(architecture)
        if abi is None:
            return _UNRESOLVED
        register_name, pointer_bits = abi

        try:
            address = int(frame.read_register(register_name))
        except Exception:
            return _UNRESOLVED

        # GDB may expose a target register as a signed integer. Normalize the
        # same register value to the pointer width declared by the selected
        # ABI; this does not inspect any alternate source.
        address &= (1 << pointer_bits) - 1

        if address == 0:
            return _UNRESOLVED

        return FuturePointerResult(address, register_name, "high")
