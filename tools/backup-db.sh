#!/usr/bin/env bash
# Weekly TFNN database backup. Makes one file, tfnn-backup-YYYY-MM-DD.dump.gpg, in the current folder:
# a full copy of the database, locked with BACKUP_PASSPHRASE so it is unreadable without it.
#
# Needs:  BACKUP_DATABASE_URL  the database connection string (the same value as DATABASE_URL on Render)
#         BACKUP_PASSPHRASE    a password you choose. Keep it somewhere safe: without it a backup cannot be opened.
#
# To restore a backup (into an EMPTY database, never straight over the live one):
#   gpg --decrypt tfnn-backup-2026-11-15.dump.gpg > tfnn.dump
#   pg_restore --no-owner --no-acl -d "<connection string of the empty database>" tfnn.dump
set -euo pipefail
: "${BACKUP_DATABASE_URL:?Set the BACKUP_DATABASE_URL secret}"
: "${BACKUP_PASSPHRASE:?Set the BACKUP_PASSPHRASE secret}"
if [ "${#BACKUP_PASSPHRASE}" -lt 12 ]; then echo "BACKUP_PASSPHRASE must be at least 12 characters." >&2; exit 1; fi

# Neon's "-pooler" address is for the app; a backup needs the direct address.
export PGURL="${BACKUP_DATABASE_URL/-pooler./.}"

# Run a Postgres tool. On GitHub it comes from the official Postgres image of the chosen version,
# so the backup tool always matches the database. PG_LOCAL=1 uses the tools installed on this machine.
pg() {
  local version="$1"; shift
  if [ "${PG_LOCAL:-0}" = 1 ]; then "$@"
  else docker run --rm -i --network host --user "$(id -u):$(id -g)" -e PGURL -v "$PWD:/work" -w /work "postgres:$version" "$@"; fi
}

num=$(pg 17 sh -c 'psql "$PGURL" -Atc "show server_version_num"')
major=$(( num / 10000 ))
echo "Database is PostgreSQL $major."

out="tfnn-backup-$(date -u +%F).dump"
pg "$major" sh -c "pg_dump \"\$PGURL\" --format=custom --no-owner --no-acl --file='$out'"

# Check the copy before trusting it: it must open, and it must hold the users table with its rows.
listing=$(pg "$major" pg_restore --list "$out")
tables=$(grep -c ' TABLE DATA ' <<<"$listing" || true)
if [ "$tables" -lt 5 ] || ! grep -q ' TABLE DATA public users ' <<<"$listing"; then
  echo "The backup looks incomplete ($tables tables with data). Not keeping it." >&2; exit 1
fi

gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
    --output "$out.gpg" "$out" 3<<<"$BACKUP_PASSPHRASE"
shred -u "$out" 2>/dev/null || unlink "$out"
echo "Backup made: $out.gpg ($(du -h "$out.gpg" | cut -f1), $tables tables with data)."
