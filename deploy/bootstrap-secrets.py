#!/usr/bin/env python3
"""Run as root on the VPS once. Never prints credentials; never overwrites .env."""
import os
import secrets
from pathlib import Path

root = Path('/opt/sellerpro')
env = root / '.env'
if not env.exists():
    values = f'POSTGRES_PASSWORD={secrets.token_hex(32)}\nCREDENTIALS_KEY={secrets.token_hex(32)}\nWORKER_CONCURRENCY=4\n'
    with os.fdopen(os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as target:
        target.write(values)

public_key = (root / 'sellerpro_actions.pub').read_text().strip()
if not public_key.startswith('ssh-ed25519 ') or '\n' in public_key:
    raise ValueError('Invalid CI public key')
authorized = Path('/root/.ssh/authorized_keys')
existing = authorized.read_text() if authorized.exists() else ''
if public_key.split()[1] not in existing:
    with authorized.open('a') as target:
        target.write('\nrestrict,command="/opt/sellerpro/ssh-entrypoint.sh" ' + public_key + '\n')
    authorized.chmod(0o600)
print('Production environment and restricted CI key configured (no secret output).')
