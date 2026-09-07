/** Run after compile: node out/test/testWhitelistPayload.js */
import * as assert from 'assert';
import { GDBDebugSession } from '../gdbDebugSession';

async function main(): Promise<void> {
    const session: any = new GDBDebugSession({ pythonPath: '', tempDir: '/tmp' });
    const commands: string[] = [];
    session.miDebugger = { sendCliCommand: async (command: string) => { commands.push(command); } };
    session.sendResponse = () => {};
    for (const flag of [undefined, false, true]) {
        const args: any = { enabledCrates: ['ax_task', 'other'] };
        if (flag !== undefined) args.asyncOnly = flag;
        await session.handleArdUpdateWhitelist({}, args);
        const command = commands.pop()!;
        assert.ok(command.startsWith('ardb-update-whitelist '));
        assert.deepStrictEqual(JSON.parse(command.slice('ardb-update-whitelist '.length)), {
            enabled_crates: ['ax_task', 'other'], async_only: flag === true,
        });
    }
    console.log('Whitelist DAP payload: 3 passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
