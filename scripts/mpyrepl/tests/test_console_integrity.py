from __future__ import annotations

import asyncio
import builtins
import io
import json
import os
import sys
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from mpyrepl import bootstrap
bootstrap.configure_import_path()
from mpyrepl.repl.output import ConsoleLines, LiveOutput
from mpyrepl.runtime.response_stream import ResponseStream, encode_frame, emitter_source
from mpyrepl.runtime.filesystem import _wrap_device_code, DeviceFsClient
from mpyrepl.runtime.models import ExecResult
from prompt_toolkit.output import DummyOutput


class RecordingOutput(DummyOutput):
    def __init__(self):
        self.parts = []

    def write(self, text):
        self.parts.append(text)


class ConsoleIntegrityTests(unittest.TestCase):
    def test_progress_lines_are_independent_of_every_split_position(self):
        text = '[1966080, null]\r\n[2031616, null]\r\n[2097152, null]\r\n中文 > [尾行]'
        expected = text.replace('\r\n', '\n')
        for split in range(len(text) + 1):
            lines = ConsoleLines()
            result = lines.feed(text[:split]) + lines.feed(text[split:]) + lines.tail
            self.assertEqual(result, expected)

    def test_carriage_return_and_no_newline_tail(self):
        lines = ConsoleLines()
        self.assertEqual(lines.feed('10%\r'), '')
        self.assertEqual(lines.tail, '10%')
        self.assertEqual(lines.feed('20%\r100%\r'), '')
        self.assertEqual(lines.feed('\n'), '100%\n')
        self.assertEqual(lines.tail, '')

    def test_long_record_is_bounded_without_character_loss(self):
        text = '中' * 70000
        lines = ConsoleLines()
        emitted = lines.feed(text)
        self.assertLess(len(lines.tail), 65536)
        self.assertEqual(emitted.replace('\n', '') + lines.tail, text)

    def test_frame_parser_preserves_every_background_byte_at_every_boundary(self):
        frame = encode_frame('test', json.dumps({'data': '中文'}).encode())
        wire = b'[' + frame + b'2031616, null]\r\nvalue > 0\r\n'
        expected = b'[2031616, null]\r\nvalue > 0\r\n'
        for split in range(len(wire) + 1):
            received, console = [], []
            parser = ResponseStream('test', received.append, console.append)
            parser.feed(wire[:split]); parser.feed(wire[split:]); parser.finish()
            self.assertEqual(b''.join(console), expected)
            self.assertEqual(json.loads(received[0]), {'data': '中文'})
            self.assertEqual(parser.error, '')

    def test_wrong_nonce_and_incomplete_prefix_are_console_output(self):
        wire = encode_frame('other', b'[]') + b'\x1eMP'
        received, console = [], []
        parser = ResponseStream('test', received.append, console.append)
        for byte in wire:
            parser.feed(bytes([byte]))
        parser.finish()
        self.assertEqual(b''.join(console), wire)
        self.assertEqual(received, [])

    def test_interleaved_and_incomplete_frames_fail_without_guessing(self):
        for wire in (b'\x1eMPY:test:2:[]noise\x1f', b'\x1eMPY:test:50:partial', b'\x1eMPY:test:xyz:abc'):
            received, console = [], []
            parser = ResponseStream('test', received.append, console.append)
            parser.feed(wire); parser.finish()
            self.assertTrue(parser.error)
            self.assertEqual(received, [])
            self.assertEqual(b''.join(console), wire)

    def test_generated_device_wrapper_matches_parser_with_background_prefix(self):
        output = io.StringIO()
        real_import = builtins.__import__
        def importer(name, *args, **kwargs):
            if name == 'sys': return SimpleNamespace(stdout=output)
            return real_import(name, *args, **kwargs)
        namespace = {'__builtins__': {**vars(builtins), '__import__': importer}}
        with mock.patch.object(sys, 'stdout', output):
            exec(_wrap_device_code("print('[', end='')\ndata = {'text': '中文'}", 'test'), namespace)
        received, console = [], []
        parser = ResponseStream('test', received.append, console.append)
        parser.feed(output.getvalue().encode()); parser.finish()
        self.assertEqual(b''.join(console), b'[')
        self.assertEqual(json.loads(received[0])['data']['text'], '中文')
        self.assertNotIn('__mpy_emit', namespace)

    def test_generated_download_runs_through_cooked_stdout_and_background_events(self):
        class Device:
            def __init__(self, source): self.background = bytearray(); self.source = source
            def console_output(self, data): self.background.extend(data)
            def exec_raw(self, source, timeout=None, stdout_consumer=None, stderr_consumer=None):
                output = io.StringIO()
                real_import = builtins.__import__
                def importer(name, *args, **kwargs):
                    if name == 'sys': return SimpleNamespace(stdout=output)
                    if name == 'os': return SimpleNamespace(stat=lambda path: self.source.stat())
                    return real_import(name, *args, **kwargs)
                namespace = {'__builtins__': {**vars(builtins), '__import__': importer,
                             'open': lambda path, mode: self.source.open(mode)}}
                with mock.patch.object(sys, 'stdout', output):
                    exec(source, namespace)
                data = b'[' + output.getvalue().replace('\n', '\r\n').encode() + b'2031616, null]\r\n'
                if stdout_consumer:
                    for index in range(0, len(data), 7): stdout_consumer(data[index:index + 7])
                return ExecResult(stdout=data, stderr=b'')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.bin'; target = Path(directory) / 'target.bin'
            data = bytes(range(256)) * 25
            source.write_bytes(data)
            device = Device(source)
            DeviceFsClient(device).read_file('/source.bin', str(target), chunk_size=1024)
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(bytes(device.background), b'[2031616, null]\r\n' * 2)

    def test_frame_emitter_uses_utf8_byte_length(self):
        output = io.StringIO()
        real_import = builtins.__import__
        def importer(name, *args, **kwargs):
            return SimpleNamespace(stdout=output) if name == 'sys' else real_import(name, *args, **kwargs)
        namespace = {'__builtins__': {**vars(builtins), '__import__': importer}}
        exec(emitter_source('test') + "__mpy_emit('中文')", namespace)
        self.assertEqual(output.getvalue().encode(), encode_frame('test', '中文'.encode()))


class LiveOutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_completion_wait_does_not_block_input_event_loop(self):
        import time
        from mpyrepl.clients.repl import ManagerCompleter
        from prompt_toolkit.document import Document
        from prompt_toolkit.completion import CompleteEvent
        class SlowClient:
            def call(self, *args): time.sleep(0.05); return []
        completer = ManagerCompleter(SlowClient())
        tick = asyncio.Event()
        asyncio.get_running_loop().call_later(0.005, tick.set)
        async def complete():
            return [value async for value in completer.get_completions_async(Document('machine.'), CompleteEvent())]
        completion = asyncio.create_task(complete())
        await asyncio.wait_for(tick.wait(), 0.5)
        self.assertFalse(completion.done())
        await completion

    async def test_slow_socket_is_bounded_and_reports_output_gap(self):
        from mpyrepl.manager.output_queue import ClientOutput
        class Writer:
            def __init__(self): self.data=[]; self.closed=False
            def write(self, data): self.data.append(data)
            async def drain(self): await asyncio.Event().wait()
            def close(self): self.closed=True
        writer=Writer(); output=ClientOutput(writer, limit=8)
        output.send(b'12345678'); output.send(b'overflow')
        self.assertTrue(writer.closed)
        self.assertIn(b'output_gap', writer.data[-1])
        await output.close()

    async def test_output_failure_does_not_hang_shutdown(self):
        class Broken(RecordingOutput):
            def write(self, text): raise OSError('output closed')
        live=LiveOutput(Broken()); live.feed('test')
        with self.assertRaisesRegex(OSError, 'output closed'):
            await asyncio.wait_for(live.close(), 1)

    async def test_editing_keeps_partial_line_in_model_and_commits_only_completed_lines(self):
        output = RecordingOutput()
        live = LiveOutput(output)
        await live.begin_prompt()
        for part in ('[', '2031616, null]', '\r'):
            live.feed(part); await live.drain()
            self.assertEqual(output.parts, [])
        live.feed('\n'); await live.drain()
        self.assertEqual(''.join(output.parts), '[2031616, null]\n')
        await live.close()

    async def test_tail_survives_prompt_execution_transition_and_shutdown_once(self):
        output = RecordingOutput(); live = LiveOutput(output)
        await live.begin_prompt()
        live.feed('unfinished'); await live.drain()
        await live.end_prompt()
        live.feed(' text\n'); await live.drain()
        await live.begin_prompt(); await live.close()
        self.assertEqual(''.join(output.parts), 'unfinished text\n')

    async def test_rendered_vt100_screen_keeps_progress_when_crlf_is_split(self):
        try:
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                import pexpect.ANSI as ansi
        except ImportError:
            self.skipTest('local VT100 screen verifier not installed')
        from prompt_toolkit.application import create_app_session
        from prompt_toolkit.input import create_pipe_input
        from prompt_toolkit.output.vt100 import Vt100_Output
        from prompt_toolkit.data_structures import Size
        from mpyrepl.repl.session import build_prompt_session
        captured = io.StringIO()
        output = Vt100_Output(captured, lambda: Size(rows=24, columns=100), enable_cpr=False)
        with create_pipe_input() as inp, create_app_session(input=inp, output=output):
            session = build_prompt_session(input=inp, output=output)
            live = LiveOutput(output); await live.begin_prompt()
            prompt = asyncio.create_task(session.prompt_async(live.message))
            await asyncio.sleep(0.02)
            for part in ('[2031616, null]\r', '\n[', '2097152, null]\r', '\n'):
                live.feed(part); await live.drain(); await asyncio.sleep(0.02)
            inp.send_text('\r'); await prompt
            await live.close()
        with mock.patch.object(ansi, 'DoLog', lambda fsm: setattr(fsm, 'memory', fsm.memory[:1])):
            screen = ansi.ANSI(24, 100); screen.write(captured.getvalue())
        rows = [row.rstrip() for row in str(screen).splitlines() if row.strip()]
        self.assertEqual(rows[:2], ['[2031616, null]', '[2097152, null]'])
