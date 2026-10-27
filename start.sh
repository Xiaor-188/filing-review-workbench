#!/bin/sh
set -eu
cd "$(dirname "$0")"
node -e 'if(Number(process.versions.node.split(".")[0])<24){console.error("Node.js 24 or newer is required.");process.exit(1)}'
if [ ! -d node_modules/pdfjs-dist ]; then
  npm ci --ignore-scripts
fi
npm start
