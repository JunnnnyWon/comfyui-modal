# comfyui-modal

**로컬 ComfyUI에서 [Modal](https://modal.com) 클라우드 GPU로 이미지를 생성하세요.**

서버를 직접 관리하거나 유휴 시간에 비용을 낼 필요가 없습니다. Modal이 필요할 때만 GPU 컨테이너를 켜고, 작업이 끝나면 자동으로 종료합니다.

[English README](./README.md)

---

## 주요 기능

- 🚀 **온디맨드 GPU** — A10G, A100, T4 중 선택. 사용한 만큼만 과금.
- ☁️ **클라우드 모델 저장** — 모델이 로컬 디스크가 아닌 Modal Volume에 저장됩니다.
- 🔄 **자동 배포** — ComfyUI 시작 시 앱 버전이 변경되면 Modal 앱을 자동으로 배포합니다.
- 🔌 **간편 연동** — 터미널 없이 ComfyUI 사이드바에서 직접 Modal 토큰을 입력해 연동합니다.
- 🔀 **로컬 폴백** — 언제든 Modal을 끄고 로컬 ComfyUI로 전환할 수 있습니다.

---

## 요구사항

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- Python 3.10 이상
- `modal` Python 패키지
- 무료 [Modal 계정](https://modal.com)

---

## 설치

### 1. ComfyUI custom nodes 디렉토리에 클론

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/JunnnnyWon/comfyui-modal
```

### 2. modal 패키지 설치

**ComfyUI를 실행하는 Python 환경**에 `modal`을 설치합니다:

```bash
pip install modal
```

> Windows 포터블 ComfyUI 사용 시, 내장 Python을 사용하세요:
> ```
> python_embeded\python.exe -m pip install modal
> ```

### 3. ComfyUI 시작

```bash
python main.py
```

사이드바에 **Modal GPU** 탭이 나타납니다.

---

## Modal 계정 연동

처음 실행하면 사이드바에 연동 화면이 표시됩니다.

1. [modal.com](https://modal.com)에서 무료 계정을 만드세요
2. **Settings → Tokens**로 이동해 새 토큰을 생성하세요
3. **Token ID** (`ak-...`)와 **Token Secret** (`as-...`)을 복사하세요
4. 사이드바 입력창에 붙여넣고 **Connect & Deploy** 버튼을 클릭하세요

Modal 앱이 백그라운드에서 자동으로 배포됩니다. 진행 상황은 사이드바에 표시됩니다.

> **토큰 형식**
> - Token ID는 `ak-` 로 시작
> - Token Secret은 `as-` 로 시작

---

## 사용법

### Modal GPU로 이미지 생성

1. 사이드바의 **Modal GPU** 탭(구름 아이콘)을 여세요
2. **Modal ON** 토글이 활성화되어 있는지 확인하세요
3. GPU를 선택하세요 (A10G 권장)
4. 평소처럼 생성을 큐에 넣으면 Modal에서 실행됩니다

### 모델 관리

모델은 로컬이 아닌 Modal Volume(`comfyui-models`)에 저장됩니다.

| 작업 | 방법 |
|------|------|
| **모델 목록 보기** | 사이드바 Models 섹션 |
| **모델 다운로드** | Add Model에 URL + 파일명 입력 후 Download 클릭 |
| **모델 삭제** | 모델 옆 ✕ 버튼 클릭 |
| **로컬 플레이스홀더 생성** | ⬇L 클릭 — ComfyUI 노드에서 참조할 수 있도록 로컬에 `modal-<파일명>` 빈 파일 생성 |

### GPU 옵션

| GPU | VRAM | 적합한 용도 |
|-----|------|------------|
| **A10G** | 24 GB | SDXL, Flux, 대부분의 워크플로우 (기본값) |
| **A100** | 40 GB | 대형 모델, 영상, 다중 LoRA |
| **T4** | 16 GB | 예산 절감용 — 느리지만 가장 저렴 |

### 로컬 모드

사이드바에서 **Modal ON → Local**로 토글하면 Modal을 우회하고 로컬 ComfyUI에서 직접 생성합니다. 다시 토글하면 클라우드로 전환됩니다.

---

## 재배포

`comfyapp.py`의 `COMFYAPP_VERSION`이 변경되면 (예: git pull 이후) ComfyUI 재시작 시 자동으로 재배포됩니다.

언제든 수동으로 재배포하려면 사이드바의 **↑ Deploy** 버튼을 클릭하세요.

---

## 업데이트

```bash
cd /path/to/ComfyUI/custom_nodes/comfyui-modal
git pull
```

ComfyUI를 재시작하세요. `comfyapp.py`가 변경되었다면 시작 시 자동으로 새 버전이 배포됩니다.

---

## 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| **modal CLI를 찾을 수 없음** | ComfyUI Python 환경에 `pip install modal` 실행 |
| **Modal 토큰 미설정** | 사이드바 연동 화면에서 토큰 입력 |
| **배포 타임아웃** | ↑ Deploy 버튼으로 재시도 |
| **Models에 503 표시** | 아직 배포 전 — ↑ Deploy 클릭 |
| **프롬프트가 Modal로 가지 않음** | 사이드바 Modal ON 토글 확인 |

---

## 동작 원리

```
ComfyUI (로컬)
  └── comfyui-modal 커스텀 노드
        ├── /prompt POST 요청을 가로챔
        ├── Modal GPU 컨테이너로 라우팅
        ├── 결과(이미지/영상)를 로컬로 스트리밍
        └── Modal Volume에 모델 다운로드 관리
```

`comfyapp.py`가 Modal 앱을 정의합니다. `ComfyAPI`(A10G) / `ComfyAPI_A100` / `ComfyAPI_T4` 세 가지 독립 클래스가 각각 Modal 컨테이너 내부에서 ComfyUI 서버를 실행합니다.

---

## 라이선스

MIT
