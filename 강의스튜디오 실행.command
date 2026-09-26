#!/bin/bash
# 더블클릭하면 강의 스튜디오를 켭니다. 끄려면 이 창을 닫거나 Ctrl+C.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  read -r -p "엔터를 누르면 창을 닫습니다."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "처음 실행: 필요한 파일을 설치합니다 (1~2분)…"
  npm install || { read -r -p "설치에 실패했습니다. 엔터를 누르면 창을 닫습니다."; exit 1; }
fi
npm start
