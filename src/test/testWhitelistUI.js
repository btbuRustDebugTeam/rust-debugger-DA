// Run: node src/test/testWhitelistUI.js (actual webview script, minimal DOM).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Element {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.listeners = {};
        this.style = {};
        this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set innerHTML(value) { this.children = []; }
    appendChild(child) { this.children.push(child); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    fire(name) { this.listeners[name]({ stopPropagation() {} }); }
}
const ids = new Map();
const messages = [];
let receive;
const document = {
    getElementById(id) {
        if (!ids.has(id)) ids.set(id, new Element('div'));
        return ids.get(id);
    },
    createElement: tag => new Element(tag),
    createTextNode: text => ({ textContent: text }),
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webview/asyncInspector.js'), 'utf8'), {
    document,
    window: { addEventListener: (_, callback) => { receive = callback; } },
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) }),
});
const grouped = { crates: { ax_task: { is_user_crate: true, symbols: [] } } };
function render() { receive({ data: { command: 'updateGroupedWhitelist', groupedWhitelist: grouped } }); }
function all(node) { return [node, ...(node.children || []).flatMap(all)]; }
function controls() {
    const nodes = all(ids.get('whitelistContainer'));
    return {
        filter: nodes.find(n => n.tag === 'label').children[0],
        crate: nodes.find(n => n.type === 'checkbox'),
        apply: nodes.find(n => n.textContent === 'Apply Whitelist'),
    };
}
render();
let c = controls();
assert.equal(c.filter.checked, false);
c.crate.checked = true;
c.crate.fire('change');
c.apply.fire('click');
assert.deepStrictEqual(messages.pop(), { command: 'updateWhitelistCrates', enabledCrates: ['ax_task'], asyncOnly: false });
messages.length = 0;
c.filter.checked = true;
c.filter.fire('change');
assert.equal(messages.length, 0, 'toggle must not apply or generate');
c.apply.fire('click');
assert.deepStrictEqual(messages.pop(), { command: 'updateWhitelistCrates', enabledCrates: ['ax_task'], asyncOnly: true });
ids.get('genWhitelistBtn').fire('click');
assert.deepStrictEqual(messages.pop(), { command: 'genWhitelist' });
render();
c = controls();
assert.equal(c.filter.checked, true, 'filter survives grouped UI rebuild');
console.log('Whitelist UI: default, OFF/ON payloads, passive toggle, Gen unchanged, persistence PASS');
