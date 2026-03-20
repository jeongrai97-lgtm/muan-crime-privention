[Cloudinary 연결 최종본]
메인관리자는 전체게시판 관리기능을 가지고 있습니다
일반관리자는 글 작성, 수정기능을 가지고 있습니다.

핵심
- 사진/영상이 Render 서버에 저장되지 않고 Cloudinary에 저장됩니다.
- Render 무료 플랜에서도 업로드 파일이 사라지지 않습니다.
- 영상은 Cloudinary 업로드 시 아이폰 호환 MP4로 변환되도록 설정했습니다.

로컬 실행
1. 압축 풀기
2. Cloudinary 계정 생성
3. .env 파일에 아래 3개 값 입력
   CLOUDINARY_CLOUD_NAME
   CLOUDINARY_API_KEY
   CLOUDINARY_API_SECRET
4. 폴더에서 cmd 열기
5. 아래 실행
   npm install
   npm start

접속 주소
- 메인: http://localhost:3000
- 관리자: http://localhost:3000/admin/login

Render 반영
1. GitHub에 압축 푼 파일 전부 덮어쓰기 업로드
2. package.json도 반드시 같이 반영
3. Render Environment에 아래 변수 추가
   CLOUDINARY_CLOUD_NAME
   CLOUDINARY_API_KEY
   CLOUDINARY_API_SECRET
   SESSION_SECRET
4. Manual Deploy → Deploy latest commit

관리자 비밀번호는 메인관리자에게 문의하세요 

