# Sandbox test probe; do not use outside its tests.
# Finds a Mu agent process in one data directory and tries to take its turn credential.
# The data directory keeps the probe off the agents of other Mu services and test runs on the same machine.
# It reads every visible process's environment through sysctl KERN_PROCARGS2, which sandboxes allow,
# and prints JSON: whether the agent's process was found, any credential in its environment, and the
# result of reading the credential file it names.
import ctypes, json, sys

agent = sys.argv[1].encode()
credential_prefix = b'MU_TOKEN_FILE=' + sys.argv[2].encode() + b'/'
libc = ctypes.CDLL(None, use_errno=True)
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
pids = (ctypes.c_int * 8192)()
count = libproc.proc_listallpids(pids, ctypes.sizeof(pids))
result = {'found': False, 'token': None, 'file': None, 'fileResult': None}
for pid in pids[:count]:
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t(1 << 20)
    buf = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        continue
    fields = buf.raw[:size.value].split(b'\0')
    if b'MU_AGENT_ID=' + agent not in fields or not any(field.startswith(credential_prefix) for field in fields):
        continue
    result['found'] = True
    for field in fields:
        if field.startswith(b'MU_TOKEN='):
            result['token'] = field[len(b'MU_TOKEN='):].decode()
        if field.startswith(b'MU_TOKEN_FILE='):
            result['file'] = field[len(b'MU_TOKEN_FILE='):].decode()
    if result['file']:
        try:
            with open(result['file']) as handle:
                result['fileResult'] = 'read'
                result['token'] = handle.read().strip()
        except OSError as error:
            result['fileResult'] = error.strerror
    if result['token'] or result['file']:
        break
print(json.dumps(result))
