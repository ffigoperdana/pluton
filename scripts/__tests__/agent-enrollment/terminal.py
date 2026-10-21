"""Run the unchanged generated command through its real hidden TTY token prompt."""
import errno
import os
import pty
import select
import signal
import time
from pathlib import Path

token = Path('/tmp/enrollment-private/token').read_bytes().strip()
pid, descriptor = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '/opt/enrollment-test/generated.sh'])
output, sent, deadline = b'', False, time.monotonic()+600
status = None
try:
    while time.monotonic() < deadline:
        if select.select([descriptor], [], [], 0.25)[0]:
            try:
                data = os.read(descriptor, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output += data
            if b'Enrollment token: ' in output and not sent:
                # read -s disables TTY echo before receiving the synthetic token.
                time.sleep(0.1)
                os.write(descriptor, token+b'\n')
                sent = True
    else:
        os.killpg(pid, signal.SIGKILL)
        raise SystemExit('FAIL generated flow exceeded bounded 600-second deadline')
    _, status = os.waitpid(pid, 0)
    assert token not in output, 'private token appeared in terminal output'
    if os.waitstatus_to_exitcode(status) != 0 or not sent:
        # No raw output, config, identity or credentials leave the container.
        Path('/tmp/enrollment-private/failure.log').write_bytes(output)
        print('Synthetic flow exit:', os.waitstatus_to_exitcode(status), 'private prompt reached:', sent)
        if not sent:
            # No enrollment secret has entered the child process at this point.
            print(output.decode(errors='replace')[-4000:])
        for line in output.decode(errors='replace').splitlines():
            if line.startswith(('[pluton-agent-installer]', 'curl:', 'fatal:', 'Reviewed Agent version')):
                print(line[:300])
        raise SystemExit('FAIL generated enrollment flow; inspect disposable private failure.log')
    print('PASS unchanged generated clone/pin/version/install block with real private TTY prompt')
finally:
    os.close(descriptor)
