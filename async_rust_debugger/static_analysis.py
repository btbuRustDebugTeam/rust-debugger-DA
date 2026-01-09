import gdb

def parse_info_functions(output):
    """
    Parse the output of 'info functions' into a list of dictionaries.
    Each dict contains: 'file', 'line', 'signature', 'return_type'
    """
    functions = []
    current_file = None
    lines = output.splitlines()
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        filename_linestart = "File "
        filename_linestart_len = len(filename_linestart)
        if line.startswith(filename_linestart):
            current_file = line[filename_linestart_len:].rstrip()
            if current_file.endswith(":"):
                current_file = current_file[:-1]
        elif current_file and ":" in line: # we hope line starts with line number and a colon
            parts = line.split(":", 1)
            if len(parts) == 2:
                try:
                    line_num = int(parts[0].strip())
                    signature = parts[1].strip()
                    # Extract return type
                    if " -> " in signature:
                        return_part = signature.split(" -> ", 1)[1].rstrip(";")
                        return_type = return_part
                    else:
                        return_type = None  # or "()" for unit
                    functions.append({
                        "file": current_file,
                        "line": line_num,
                        "signature": signature,
                        "return_type": return_type
                    })
                except ValueError:
                    continue  # Skip if line_num not int
    return functions

# Example usage:
# output = gdb.execute("info functions", to_string=True)
# funcs = parse_info_functions(output)
# for f in funcs:
#     print(f)

