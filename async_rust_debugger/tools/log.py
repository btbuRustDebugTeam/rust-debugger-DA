import gdb
import os

class Log(gdb.Command):
    def __init__(self):
        super(Log, self).__init__("log", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        args = arg.split()
        if not args:
            print("Usage: log start | log end")
            return
        # create temp directory (ASYNC_RUST_DEBUGGER_TEMP_DIR env var) if it doesn't exist
        temp_dir = os.getenv("ASYNC_RUST_DEBUGGER_TEMP_DIR", "./temp")
        if not os.path.exists(temp_dir):
            os.makedirs(temp_dir)
        gdb.execute(f"set logging file {temp_dir}/gdb.txt")
        subcmd = args[0]
        if subcmd == "start":
            gdb.execute("set logging enabled on")
        elif subcmd == "end":
            gdb.execute("set logging enabled off")
        else:
            print("Unknown subcommand: %s" % subcmd)

Log()