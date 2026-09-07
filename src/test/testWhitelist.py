"""Offline tests: python3 -m unittest discover -s src/test -p 'testWhitelist.py' -v.

Compile the actual command and parser AST in isolation to avoid package import
installing GDB commands. Only GDB and observer installation are mocked.
"""
import ast
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[2] / 'async_rust_debugger/runtime_trace.py'
ASYNC_NAMES = [
    'ax_task::future::time::{impl#1}::poll',
    'ax_task::future::time::sleep_until::{async_fn#0}',
]


class WhitelistTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, ASYNC_RUST_DEBUGGER_TEMP_DIR=self.temp.name)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.grouped = Path(self.temp.name) / 'poll_functions_grouped.json'
        self.flat = Path(self.temp.name) / 'poll_functions.txt'
        symbols = [{'name': n, 'kind': 'async'} for n in ASYNC_NAMES]
        symbols += [{'name': f'ax_task::sync_{i}', 'kind': 'sync'} for i in range(200)]
        self.grouped.write_text(json.dumps({'crates': {
            'ax_task': {'symbols': symbols},
            'other': {'symbols': [{'name': 'other::poll', 'kind': 'async'}]},
            'sync_only': {'symbols': [{'name': 'sync_only::run', 'kind': 'sync'},
                                      {'name': 'legacy::unknown'}]},
        }}))
        self.original = self.grouped.read_bytes()
        self.scope = dict(os=os, json=json,
                          gdb=types.SimpleNamespace(Command=object, write=Mock()),
                          _invalidate_whitelist_addrs=Mock(),
                          _install_whitelist_runtime_event_breakpoints=Mock(return_value=0))
        tree = ast.parse(SOURCE.read_text())
        nodes = [n for n in tree.body if getattr(n, 'name', '') in
                 ('ARDUpdateWhitelistCommand', '_load_whitelist_file')]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), self.scope)
        cls = self.scope['ARDUpdateWhitelistCommand']
        self.command = cls.__new__(cls)

    def apply(self, payload):
        self.command.invoke(json.dumps(payload), False)
        lines = self.flat.read_text().splitlines()
        self.assertEqual([int(s.split(' ', 1)[0]) for s in lines], list(range(len(lines))))
        self.assertEqual(self.grouped.read_bytes(), self.original)
        self.scope['_install_whitelist_runtime_event_breakpoints'].assert_called()
        return [s.split(' ', 1)[1] for s in lines]

    def test_legacy_snake_case_payload(self):
        names = self.apply({'enabled_crates': ['ax_task']})
        self.assertEqual(len(names), 202)
        self.assertEqual(names[:2], ASYNC_NAMES)

    def test_explicit_off(self):
        self.assertEqual(len(self.apply({'enabled_crates': ['ax_task'], 'async_only': False})), 202)

    def test_on_writes_two_exact_symbols_and_reloads(self):
        self.assertEqual(self.apply({'enabled_crates': ['ax_task'], 'async_only': True}), ASYNC_NAMES)
        self.assertEqual(self.scope['_WHITELIST_EXACT'], set(ASYNC_NAMES))

    def test_multiple_selected_crates(self):
        self.assertEqual(self.apply({'enabled_crates': ['ax_task', 'other'], 'async_only': True}),
                         ASYNC_NAMES + ['other::poll'])

    def test_no_async_overwrites_previous_whitelist_with_empty(self):
        self.apply({'enabled_crates': ['ax_task']})
        self.assertEqual(self.apply({'enabled_crates': ['sync_only'], 'async_only': True}), [])
        self.assertEqual(self.scope['_WHITELIST_EXACT'], set())

    def test_missing_kind_is_preserved_when_off(self):
        self.assertEqual(self.apply({'enabled_crates': ['sync_only']}),
                         ['sync_only::run', 'legacy::unknown'])

    def test_no_selected_crates(self):
        self.assertEqual(self.apply({'enabled_crates': [], 'async_only': True}), [])


if __name__ == '__main__':
    unittest.main()
