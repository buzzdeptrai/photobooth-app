# Photo Booth AI — Digital Week Novo Nordisk

Nhân viên mở camera → chụp ảnh → chọn style → nhận ảnh AI → tải về.

## Cài đặt

```bash
npm install
```

## Cấu hình

Tạo file `.env` từ template:

```bash
cp .env.example .env
```

Sửa `GEMINI_API_KEY` trong `.env` thành API key thật từ Google AI Studio.

## Chạy

```bash
npm start
```

Mở trình duyệt: http://localhost:3000

## Cấu trúc

```
├── server.js          # Backend Express: /api/styles, /api/generate
├── public/
│   └── index.html     # Frontend single-page app
├── package.json
├── .env.example       # Template biến môi trường
└── .gitignore
```

## Biến môi trường

| Biến | Mô tả | Mặc định |
|------|--------|----------|
| `GEMINI_API_KEY` | API key Google Gemini | (bắt buộc) |
| `PORT` | Cổng server | 3000 |
| `MAX_IMAGE_MB` | Giới hạn dung lượng ảnh (MB) | 5 |
