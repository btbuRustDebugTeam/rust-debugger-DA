"use strict";
// Ported from code-debug src/mibase.ts (BreakpointGroups class + supporting types)
// Decoupled from MI2DebugSession: uses IDebuggerBackend interface instead of direct session reference.
// SSH support removed (not needed for rust-debugger-DA).
Object.defineProperty(exports, "__esModule", { value: true });
exports.BreakpointGroups = exports.HookBreakpoints = exports.HookBreakpoint = exports.HookBreakpointJSONFriendly = exports.Border = void 0;
exports.toFunctionString = toFunctionString;
exports.toHookBreakpoint = toHookBreakpoint;
class Border {
    constructor(filepath, line) {
        this.filepath = filepath;
        this.line = line;
    }
}
exports.Border = Border;
class HookBreakpointJSONFriendly {
}
exports.HookBreakpointJSONFriendly = HookBreakpointJSONFriendly;
function toFunctionString(obj) {
    return `(function(${obj.args.join(",")}) { ${obj.body} })`;
}
function toHookBreakpoint(h) {
    return new HookBreakpoint(h.breakpoint, toFunctionString(h.behavior));
}
class HookBreakpoint {
    constructor(breakpoint, behavior) {
        this.breakpoint = breakpoint;
        this.behavior = behavior;
    }
}
exports.HookBreakpoint = HookBreakpoint;
// use this to get next process name
class HookBreakpoints {
    constructor(hooks) {
        this.hooks = hooks;
    }
    // we cannot compare functions so we always override them
    set(newHook) {
        let hookPositionAlreadyExists = false;
        for (const hook of this.hooks) {
            if (hook.breakpoint.file === newHook.breakpoint.file && hook.breakpoint.line === newHook.breakpoint.line) {
                hookPositionAlreadyExists = true;
                hook.behavior = newHook.behavior;
            }
        }
        if (hookPositionAlreadyExists === false) {
            this.hooks.push(new HookBreakpoint(newHook.breakpoint, newHook.behavior));
        }
    }
    // again, we cannot compare functions, so if linenumber and filepath are the same, the hook will be removed
    remove(breakpointOfHook) {
        this.hooks = this.hooks.filter(b => (b.breakpoint.file !== breakpointOfHook.file || b.breakpoint.line !== breakpointOfHook.line));
    }
    [Symbol.iterator]() {
        let index = 0;
        const hooks = this.hooks;
        return {
            next() {
                if (index < hooks.length) {
                    return { done: false, value: hooks[index++] };
                }
                else {
                    return { done: true, value: undefined };
                }
            }
        };
    }
}
exports.HookBreakpoints = HookBreakpoints;
// we recommend the name of BreakpointGroup to be the full file path of the debugged file
// when one file is sufficient for one BreakpointGroup
class BreakpointGroup {
    constructor(name, setBreakpointsArguments, hooks, borders) {
        this.name = name;
        this.setBreakpointsArguments = setBreakpointsArguments;
        this.hooks = hooks;
        this.borders = borders;
    }
}
// Manages breakpoint caching, switching symbol files, and breakpoint group transitions.
class BreakpointGroups {
    constructor(currentBreakpointGroupName, session, nextBreakpointGroup) {
        this.session = session;
        this.groups = [];
        this.groups.push(new BreakpointGroup(currentBreakpointGroupName, [], new HookBreakpoints([]), []));
        this.currentBreakpointGroupName = currentBreakpointGroupName;
        this.nextBreakpointGroup = nextBreakpointGroup;
    }
    // Let GDB remove breakpoints of current breakpoint group
    // but the breakpoints info in current breakpoint group remains unchanged
    disableCurrentBreakpointGroupBreakpoints() {
        let currentIndex = -1;
        for (let j = 0; j < this.groups.length; j++) {
            if (this.groups[j].name === this.getCurrentBreakpointGroupName()) {
                currentIndex = j;
            }
        }
        if (currentIndex === -1) {
            return;
        }
        this.groups[currentIndex].setBreakpointsArguments.forEach((e) => {
            this.session.miDebugger.clearBreakPoints(e.source.path);
            this.session.showInformationMessage("disableCurrentBreakpointGroupBreakpoints successed. index= " + currentIndex);
        });
    }
    // When a breakpoint is triggered and the address space changes (e.g. kernel => user process),
    // cache the old group's breakpoints, clear them from GDB, unload old symbol files,
    // load new symbol files, and restore new group's breakpoints.
    updateCurrentBreakpointGroup(updateTo, continueAfterUpdate = false) {
        let newIndex = -1;
        for (let i = 0; i < this.groups.length; i++) {
            if (this.groups[i].name === updateTo) {
                newIndex = i;
            }
        }
        if (newIndex === -1) {
            this.groups.push(new BreakpointGroup(updateTo, [], new HookBreakpoints([]), []));
            newIndex = this.groups.length - 1;
        }
        let oldIndex = -1;
        for (let j = 0; j < this.groups.length; j++) {
            if (this.groups[j].name === this.getCurrentBreakpointGroupName()) {
                oldIndex = j;
            }
        }
        if (oldIndex === -1) {
            this.groups.push(new BreakpointGroup(this.getCurrentBreakpointGroupName(), [], new HookBreakpoints([]), []));
            oldIndex = this.groups.length - 1;
        }
        // Update name immediately so callers see the new group right away.
        this.currentBreakpointGroupName = this.groups[newIndex].name;
        this.session.showInformationMessage("breakpoint group changed to " + updateTo);
        // 1. Clear old group's breakpoints from GDB (parallel, order doesn't matter)
        const clearOldPromises = this.groups[oldIndex].setBreakpointsArguments.map((e) => this.session.miDebugger.clearBreakPoints(e.source.path));
        // 2. Unload old symbol files, load new symbol files — must complete before
        //    re-inserting breakpoints so GDB can resolve source locations correctly.
        const oldSymbolFiles = eval(this.session.breakpointGroupNameToDebugFilePaths)(this.groups[oldIndex].name);
        const newSymbolFiles = eval(this.session.breakpointGroupNameToDebugFilePaths)(this.groups[newIndex].name);
        const toPath = (e) => typeof e === 'string' ? e : e.path;
        const toTextAddr = (e) => typeof e === 'string' ? undefined : e.textAddr;
        Promise.all(clearOldPromises)
            .then(() => Promise.all(oldSymbolFiles.map(f => this.session.miDebugger.removeSymbolFile(toPath(f)).catch(() => { }))))
            .then(() => Promise.all(newSymbolFiles.map(f => this.session.miDebugger.addSymbolFile(toPath(f), toTextAddr(f)).catch(() => { }))))
            .then(() => {
            // 3. Re-insert new group's breakpoints
            const breakpointPromises = this.groups[newIndex].setBreakpointsArguments.map((args) => {
                return this.session.miDebugger.clearBreakPoints(args.source.path).then(() => {
                    const path = args.source.path;
                    const all = args.breakpoints.map((brk) => {
                        return this.session.miDebugger.addBreakPoint({
                            file: path,
                            line: brk.line,
                            condition: brk.condition ?? "",
                            countCondition: brk.hitCondition,
                            logMessage: brk.logMessage
                        });
                    });
                    return Promise.all(all);
                }, (_msg) => []);
            });
            return Promise.all(breakpointPromises);
        })
            .then((nestedResults) => {
            // 4. Notify session to send BreakpointEvent('changed') for each restored BP
            const flat = nestedResults.flat();
            this.session.onBreakpointsRestored(flat);
            // 5. Now safe to continue execution
            if (continueAfterUpdate) {
                this.session.miDebugger.continue();
            }
        })
            .catch(err => {
            console.error('[ardb] updateCurrentBreakpointGroup failed:', err);
            if (continueAfterUpdate) {
                this.session.miDebugger.continue();
            }
        });
    }
    // there should NOT be a `setCurrentBreakpointGroupName()` because changing the name also
    // requires changing the breakpoint group itself — that's what `updateCurrentBreakpointGroup()` does.
    getCurrentBreakpointGroupName() {
        return this.currentBreakpointGroupName;
    }
    // notice it can return undefined
    getBreakpointGroupByName(groupName) {
        for (const k of this.groups) {
            if (k.name === groupName) {
                return k;
            }
        }
        return undefined;
    }
    // notice it can return undefined
    getCurrentBreakpointGroup() {
        const groupName = this.getCurrentBreakpointGroupName();
        for (const k of this.groups) {
            if (k.name === groupName) {
                return k;
            }
        }
        return undefined;
    }
    getNextBreakpointGroup() {
        return this.nextBreakpointGroup;
    }
    setNextBreakpointGroup(groupName) {
        this.nextBreakpointGroup = groupName;
    }
    getAllBreakpointGroups() {
        return this.groups;
    }
    /** Returns true if the named group has at least one user-set breakpoint. */
    groupHasBreakpoints(groupName) {
        const group = this.getBreakpointGroupByName(groupName);
        if (!group)
            return false;
        return group.setBreakpointsArguments.some(args => (args.breakpoints ?? []).length > 0);
    }
    // save breakpoint information into a breakpoint group, but NOT let GDB set those breakpoints yet
    saveBreakpointsToBreakpointGroup(args, groupName) {
        let found = -1;
        for (let i = 0; i < this.groups.length; i++) {
            if (this.groups[i].name === groupName) {
                found = i;
            }
        }
        if (found === -1) {
            this.groups.push(new BreakpointGroup(groupName, [], new HookBreakpoints([]), []));
            found = this.groups.length - 1;
        }
        let alreadyThere = -1;
        for (let i = 0; i < this.groups[found].setBreakpointsArguments.length; i++) {
            if (this.groups[found].setBreakpointsArguments[i].source.path === args.source.path) {
                this.groups[found].setBreakpointsArguments[i] = args;
                alreadyThere = i;
            }
        }
        if (alreadyThere === -1) {
            this.groups[found].setBreakpointsArguments.push(args);
        }
    }
    updateBorder(border) {
        const groupNamesOfBorder = eval(this.session.filePathToBreakpointGroupNames)(border.filepath);
        for (const groupNameOfBorder of groupNamesOfBorder) {
            let groupExists = false;
            for (const group of this.groups) {
                if (group.name === groupNameOfBorder) {
                    groupExists = true;
                    group.borders = group.borders ?? [];
                    group.borders.push(border);
                }
            }
            if (groupExists === false) {
                this.groups.push(new BreakpointGroup(groupNameOfBorder, [], new HookBreakpoints([]), [border]));
            }
        }
    }
    // breakpoints are still there but they are no longer borders
    disableBorder(border) {
        const groupNamesOfBorder = eval(this.session.filePathToBreakpointGroupNames)(border.filepath);
        for (const groupNameOfBorder of groupNamesOfBorder) {
            for (const group of this.groups) {
                if (group.name === groupNameOfBorder) {
                    group.borders = [];
                }
            }
        }
    }
    updateHookBreakpoint(hook) {
        const groupNames = eval(this.session.filePathToBreakpointGroupNames)(hook.breakpoint.file);
        for (const groupName of groupNames) {
            let groupExists = false;
            for (const existingGroup of this.groups) {
                if (existingGroup.name === groupName) {
                    groupExists = true;
                    existingGroup.hooks.set(toHookBreakpoint(hook));
                    this.session.showInformationMessage('hooks set ' + JSON.stringify(existingGroup.hooks));
                }
            }
            if (groupExists === false) {
                this.groups.push(new BreakpointGroup(groupName, [], new HookBreakpoints([toHookBreakpoint(hook)]), undefined));
            }
        }
    }
    // the breakpoints are still set, but they will no longer trigger user-defined behavior.
    disableHookBreakpoint(hook) {
        const groupNames = eval(this.session.filePathToBreakpointGroupNames)(hook.breakpoint.file);
        for (const groupName of groupNames) {
            for (const existingGroup of this.groups) {
                if (existingGroup.name === groupName) {
                    existingGroup.hooks.remove(hook.breakpoint);
                }
            }
        }
    }
    // only used for reset
    removeAllBreakpoints() {
        this.groups = [];
    }
}
exports.BreakpointGroups = BreakpointGroups;
//# sourceMappingURL=breakpointGroups.js.map