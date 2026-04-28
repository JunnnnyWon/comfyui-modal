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

### 방법 A — Windows 포터블 (Windows 사용자 권장)

Windows 포터블 패키지는 자체 격리된 Python(`python_embeded`)을 포함합니다. 시스템 Python이 아닌 해당 Python에 `modal`을 설치해야 합니다.

**1. ComfyUI Windows 포터블 다운로드 및 압축 해제**

[ComfyUI 릴리즈](https://github.com/comfyanonymous/ComfyUI/releases)에서 다운로드 후 `C:\ComfyUI_windows_portable\` 등의 폴더에 압축을 해제합니다.

**2. custom_nodes에 이 저장소 클론**

명령 프롬프트(CMD)를 열고 실행합니다:

```bat
cd C:\ComfyUI_windows_portable\ComfyUI\custom_nodes
git clone https://github.com/JunnnnyWon/comfyui-modal
```

> `git`이 없다면 GitHub에서 ZIP을 다운로드해 `custom_nodes` 안에 `comfyui-modal` 폴더로 압축 해제하세요.

**3. 내장 Python에 modal 설치**

```bat
C:\ComfyUI_windows_portable\python_embeded\python.exe -m pip install modal
```

**4. ComfyUI 시작**

`run_nvidia_gpu.bat` (또는 `run_cpu.bat`)을 더블클릭합니다.

사이드바에 **Modal GPU** 탭이 나타납니다.

---

### 방법 B — 일반 설치 (Mac / Linux / Windows venv)

**1. ComfyUI custom nodes 디렉토리에 클론**

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/JunnnnyWon/comfyui-modal
```

**2. modal 패키지 설치**

**ComfyUI를 실행하는 Python 환경**에 `modal`을 설치합니다:

```bash
pip install modal
```

**3. ComfyUI 시작**

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

### 빠른 참조

| 증상 | 해결 방법 |
|------|----------|
| **modal CLI를 찾을 수 없음** | ComfyUI Python 환경에 `pip install modal` 실행 |
| **Modal 토큰 미설정** | 사이드바 연동 화면에서 토큰 입력 |
| **배포 타임아웃** | ↑ Deploy 버튼으로 재시도 |
| **Models에 503 표시** | 아직 배포 전 — ↑ Deploy 클릭 |
| **프롬프트가 Modal로 가지 않음** | 사이드바 Modal ON 토글 확인 |
| **노드 드롭다운에 모델이 안 보임** | 모델 옆 ⬇L 클릭, 또는 재다운로드 — placeholder가 자동 생성됨 |
| **unet_name 드롭다운이 비어있음** | Add Model로 모델 다운로드 — `unet` 폴더 지원 |

---

### 알려진 문제 및 해결

#### Windows: 배포 중 `cp949` 코덱 오류

**증상**
```
[comfyui-modal] Deploy failed: 'cp949' codec can't encode character '\u2713'
```

**원인**
Windows CMD/PowerShell의 기본 인코딩이 `cp949`입니다. Modal CLI가 출력하는 유니코드 문자(예: `✓`)를 읽지 못해 발생합니다.

**해결**
v1.0.0 이상에서 이미 패치됐습니다. 이 오류가 발생하면 노드를 업데이트하세요:
```bat
cd ComfyUI\custom_nodes\comfyui-modal
git pull
```

---

#### 배포 후 Check 버튼이 항상 Offline 표시

**증상**
배포는 성공했는데 **Check** 버튼을 눌러도 항상 `Offline`으로 표시됩니다.

**원인**
`min_containers=0` 설정으로 평소엔 Modal 컨테이너가 꺼져 있습니다. 기존 Check 버튼이 컨테이너를 깨우려다 응답 전에 타임아웃이 발생했습니다.

**해결**
이미 패치됐습니다. **Check** 버튼은 이제 배포 상태만 즉시 확인합니다(컨테이너 깨우지 않음). 컨테이너가 실제로 살아있는지 확인하려면 **Ping** 버튼을 사용하세요 — cold start 시 1~3분 소요될 수 있습니다.

---

#### 생성 직후 컨테이너가 바로 종료됨

**정상 동작입니다**
`scaledown_window=2`는 의도적인 설정으로, 마지막 요청 후 2초 뒤에 컨테이너가 자동 종료되어 비용을 최소화합니다. 다음 생성 시 cold start(1~3분)가 다시 발생합니다.

컨테이너를 더 오래 유지하려면 `comfyapp.py`를 수정하세요:
```python
scaledown_window=120,  # 마지막 요청 후 2분간 유지
```
수정 후 **↑ Deploy**를 클릭해 재배포하세요.

---

#### 모델 URL 입력 시 "http:// 또는 https:// 프로토콜 누락" 오류

**증상**
```
Error: Request URL is missing an 'http://' or 'https://' protocol.
```

**원인**
URL에 `https://`가 없는 채로 전송됐습니다.

**해결**
이미 패치됐습니다. URL 입력창에 `https://`가 없으면 자동으로 추가됩니다. `git pull`로 업데이트하세요.

---

#### 다운로드 후 unet_name / 모델 드롭다운이 비어있음

**원인**
Modal Volume의 모델은 클라우드에 저장됩니다. ComfyUI의 로컬 파일 스캐너가 이를 인식하지 못합니다.

**해결**
다운로드 완료 후 로컬 `models/` 디렉토리에 빈 placeholder 파일(`modal-<파일명>`)이 자동으로 생성됩니다. 이 파일 덕분에 ComfyUI 드롭다운에 모델이 표시됩니다.

placeholder가 없으면 Models 목록에서 해당 모델 옆 **⬇L** 버튼을 클릭해 수동으로 생성하세요.

---

### 제거 방법

커스텀 노드 폴더를 삭제해도 placeholder 파일은 **자동으로 삭제되지 않습니다**. 완전히 제거하려면:

**1. placeholder 파일 삭제**

```bash
# Mac / Linux
find /path/to/ComfyUI/models -name "modal-*" -delete

# Windows (PowerShell)
Get-ChildItem -Path "C:\ComfyUI_windows_portable\ComfyUI\models" -Recurse -Filter "modal-*" | Remove-Item
```

**2. 커스텀 노드 삭제**

```bash
rm -rf /path/to/ComfyUI/custom_nodes/comfyui-modal
```

**3. (선택) Modal 토큰 삭제**

```bash
# Mac / Linux
rm ~/.modal.toml

# Windows
del %USERPROFILE%\.modal.toml
```

**4. (선택) Modal 클라우드 리소스 삭제**

[modal.com](https://modal.com) → Apps → `comfyui` 삭제, Volumes → `comfyui-models` 삭제

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
