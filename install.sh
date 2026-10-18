#!/usr/bin/env sh
# Install omo-tips-translate:
#   curl -fsSL https://raw.githubusercontent.com/yjacket/omo-tips-translate/main/install.sh | sh
set -e

if ! command -v omo >/dev/null 2>&1; then
	echo "omo is not on PATH. Install OMO first, then run this script again." >&2
	exit 1
fi

omo install git:github.com/yjacket/omo-tips-translate
echo "Type /reload in running omo sessions."
