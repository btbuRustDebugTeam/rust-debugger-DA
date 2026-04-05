"use strict";
// Ported from code-debug src/OSStateMachine.ts
// A simple state machine powering breakpoint group switching functionality.
// If you don't know how the following code works, please check
// https://dev.to/davidkpiano/you-don-t-need-a-library-for-state-machines-k7h
//
// You can also visualize this state machine interactively at
// https://stately.ai/registry/editor/8e3d023e-bd57-45ad-9a3c-d2ad1b304cc7?machineId=c1226f8e-8ac5-4b6c-8239-eda810f55a09&mode=Simulate
Object.defineProperty(exports, "__esModule", { value: true });
exports.OSState = exports.OSEvent = exports.OSStateMachine = exports.DebuggerActions = exports.OSEvents = exports.OSStates = void 0;
exports.stateTransition = stateTransition;
var OSStates;
(function (OSStates) {
    OSStates[OSStates["kernel"] = 0] = "kernel";
    OSStates[OSStates["kernel_single_step_to_user"] = 1] = "kernel_single_step_to_user";
    OSStates[OSStates["user"] = 2] = "user";
    OSStates[OSStates["user_single_step_to_kernel"] = 3] = "user_single_step_to_kernel";
})(OSStates || (exports.OSStates = OSStates = {}));
var OSEvents;
(function (OSEvents) {
    OSEvents[OSEvents["STOPPED"] = 0] = "STOPPED";
    OSEvents[OSEvents["AT_KERNEL"] = 1] = "AT_KERNEL";
    OSEvents[OSEvents["AT_KERNEL_TO_USER_BORDER"] = 2] = "AT_KERNEL_TO_USER_BORDER";
    OSEvents[OSEvents["AT_USER"] = 3] = "AT_USER";
    OSEvents[OSEvents["AT_USER_TO_KERNEL_BORDER"] = 4] = "AT_USER_TO_KERNEL_BORDER";
})(OSEvents || (exports.OSEvents = OSEvents = {}));
var DebuggerActions;
(function (DebuggerActions) {
    DebuggerActions[DebuggerActions["check_if_kernel_yet"] = 0] = "check_if_kernel_yet";
    DebuggerActions[DebuggerActions["check_if_user_yet"] = 1] = "check_if_user_yet";
    DebuggerActions[DebuggerActions["check_if_kernel_to_user_border_yet"] = 2] = "check_if_kernel_to_user_border_yet";
    DebuggerActions[DebuggerActions["check_if_user_to_kernel_border_yet"] = 3] = "check_if_user_to_kernel_border_yet";
    DebuggerActions[DebuggerActions["start_consecutive_single_steps"] = 4] = "start_consecutive_single_steps";
    DebuggerActions[DebuggerActions["low_level_switch_breakpoint_group_to_high_level"] = 5] = "low_level_switch_breakpoint_group_to_high_level";
    DebuggerActions[DebuggerActions["high_level_switch_breakpoint_group_to_low_level"] = 6] = "high_level_switch_breakpoint_group_to_low_level";
    DebuggerActions[DebuggerActions["try_get_next_breakpoint_group_name"] = 7] = "try_get_next_breakpoint_group_name";
})(DebuggerActions || (exports.DebuggerActions = DebuggerActions = {}));
// the OSStateMachine const is exported while the OSStateMachine type is NOT.
// if you change the behavior of this OSStateMachine, remember to add comments.
exports.OSStateMachine = {
    initial: OSStates.kernel,
    states: {
        [OSStates.kernel]: {
            on: {
                [OSEvents.STOPPED]: {
                    target: OSStates.kernel,
                    actions: [
                        { type: DebuggerActions.try_get_next_breakpoint_group_name }, // if got, save it to a variable. if not, stay the same. initial is "initproc"
                        { type: DebuggerActions.check_if_kernel_to_user_border_yet }, // if yes, event `AT_KERNEL_TO_USER_BORDER` happens
                    ]
                },
                [OSEvents.AT_KERNEL_TO_USER_BORDER]: {
                    target: OSStates.kernel_single_step_to_user,
                    actions: [
                        { type: DebuggerActions.start_consecutive_single_steps }
                    ]
                }
            }
        },
        [OSStates.kernel_single_step_to_user]: {
            on: {
                [OSEvents.STOPPED]: {
                    target: OSStates.kernel_single_step_to_user,
                    actions: [
                        { type: DebuggerActions.check_if_user_yet } // if yes, event `AT_USER` happens. if no, keep single stepping
                    ]
                },
                [OSEvents.AT_USER]: {
                    target: OSStates.user,
                    actions: [
                        // border breakpoint is included in breakpoint group.
                        // also switch debug symbol file
                        // after breakpoint group changed, set the next breakpoint group to the kernel's breakpoint group.
                        { type: DebuggerActions.low_level_switch_breakpoint_group_to_high_level }
                    ]
                }
            }
        },
        [OSStates.user]: {
            on: {
                [OSEvents.STOPPED]: {
                    target: OSStates.user,
                    actions: [
                        { type: DebuggerActions.check_if_user_to_kernel_border_yet }, // if yes, event `AT_USER_TO_KERNEL_BORDER` happens
                    ]
                },
                [OSEvents.AT_USER_TO_KERNEL_BORDER]: {
                    target: OSStates.user_single_step_to_kernel,
                    actions: [
                        { type: DebuggerActions.start_consecutive_single_steps } // no need to `get_next_breakpoint_group_name` because the breakpoint group is already set when kernel changed to user breakpoint group
                    ]
                }
            }
        },
        [OSStates.user_single_step_to_kernel]: {
            on: {
                [OSEvents.STOPPED]: {
                    target: OSStates.user_single_step_to_kernel,
                    actions: [
                        { type: DebuggerActions.check_if_kernel_yet } // if yes, event `AT_KERNEL` happens. if no, keep single stepping
                    ]
                },
                [OSEvents.AT_KERNEL]: {
                    target: OSStates.kernel,
                    actions: [
                        // after breakpoint group changed, set the next breakpoint group to the former user breakpoint group as a default value.
                        // if a hook is triggered during kernel execution, the next breakpoint group will be set to the return value of hook behavior function.
                        { type: DebuggerActions.high_level_switch_breakpoint_group_to_low_level } // including the border breakpoint
                    ]
                }
            }
        },
    }
};
class OSEvent {
    constructor(eventType) {
        this.type = eventType;
    }
}
exports.OSEvent = OSEvent;
class OSState {
    constructor(status) {
        this.status = status;
    }
}
exports.OSState = OSState;
// Please do the returned actions!
// Fix #5: actions was possibly undefined, now returns [] as fallback
function stateTransition(machine, state, event) {
    const nextStateNode = machine
        .states[state.status]
        .on?.[event.type]
        ?? { target: state.status };
    const nextState = {
        ...state,
        status: nextStateNode.target
    };
    return [nextState, nextStateNode.actions ?? []];
}
//# sourceMappingURL=OSStateMachine.js.map