when querying state machines like async_fn_env, 
ptype and print does not work because GDB considers `{}` and `#` illegal as a type name. That's the reason of "Struct expression applied to non-struct type" and "overlong character literal" error messages.
This can be solved by using python APIs. Which is our approach.