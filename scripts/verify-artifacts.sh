#!/bin/bash
# Verify Sunday IDE build artifacts after CI goes green.
# Usage: ./verify-artifacts.sh <run-id>
set -e
RUN_ID="${1:?Usage: $0 <run-id>}"
REPO="Vivek492005/Sunday"

echo "=== Artifacts for run $RUN_ID ==="
curl -s "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID/artifacts?per_page=20" | \
  node -e "
    let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
      const j=JSON.parse(d);
      (j.artifacts||[]).forEach(a=>{
        const mb=(a.size_in_bytes/1048576).toFixed(1);
        console.log(a.name,'|',mb+'MB','|',a.expired?'EXPIRED':'active');
      });
      if(!(j.artifacts||[]).length) console.log('No artifacts found');
    });
  "

echo ""
echo "=== Expected ==="
echo "sunday-ide-windows-x64-0.1.0 (zip with Inno Setup installer)"
echo "sunday-ide-linux-x64-0.1.0 (tar.gz)"
echo "sunday-ide-macos-arm64-0.1.0 (dmg or zip)"
