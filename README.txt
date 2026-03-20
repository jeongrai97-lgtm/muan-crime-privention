[바로 실행용]
이 압축파일에는 .env 파일이 이미 들어있습니다.
관리자 비밀번호는 1234 입니다.

무안경찰서 범죄예방가이드 - 사진/영상 업로드 + PWA 버전

[1] 로컬 실행
1. Node.js 설치
2. 압축 해제
3. .env.example 파일을 복사해서 .env 파일 생성
4. .env 값 변경
5. 아래 명령 실행

   npm install
   npm start

6. 브라우저 접속
   http://localhost:3000

관리자 로그인 주소
- http://localhost:3000/admin/login

[2] 주요 기능
- 사용자: 게시글 보기만 가능
- 관리자: 로그인 후 글 등록/삭제 가능
- 사진 직접 업로드 가능
- 1분 내외 MP4 영상 업로드 가능 (최대 200MB)
- PWA 지원으로 모바일에서 홈 화면 추가 가능

[3] 업로드 규칙
- 이미지: jpg, png, webp, gif
- 영상: mp4, webm, ogg, mov
- 최대 파일 크기: 200MB
- 권장: 1분 이내 MP4

[4] 실제 배포 추천 순서
1. 서버 준비
   - 가장 쉬움: Render 또는 Railway
   - 직접 운영: Ubuntu VPS + Nginx + PM2

2. 서버 업로드 후 실행
   npm install
   npm start

3. 환경변수 설정
   - ADMIN_PASSWORD 강하게 변경
   - SESSION_SECRET 강하게 변경

4. 도메인 연결
   - 예: crime.muan-police.kr

5. HTTPS 적용
   - Nginx + Let's Encrypt 추천

6. 백업
   - crime_guide.db
   - public/uploads 폴더

[5] 공공기관 실사용 전 권장 추가사항
- 관리자 아이디/비밀번호 분리
- 게시글 수정 기능
- 관리자 계정 2개 이상
- 접근 로그 저장
- 업로드 파일 악성코드 점검
- 정기 백업
- 개인정보/보안 점검

[6] 아주 쉬운 배포 설명
- Render: GitHub에 올린 뒤 새 Web Service 생성
- Railway: GitHub 연동 후 배포
- VPS: 서버에 Node.js 설치 후 PM2로 실행

[7] 참고
이 버전은 '실사용 시작점'으로 적합합니다.
정식 기관 배포 전에는 보안 설정과 운영 절차를 추가하는 것이 좋습니다.


[9] 카테고리 구조 정리
- theft   : 절도예방수칙
- fraud   : 사기예방수칙
- foreign : 외국인 범죄예방수칙
- notice  : 무안경찰알림

기존 데이터가 있을 경우 서버 실행 시 자동으로 아래처럼 정리됩니다.
- phishing -> foreign
- foreign -> notice
