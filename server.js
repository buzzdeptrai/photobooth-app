require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { GoogleGenAI } = require('@google/genai');
const storage = require('./lib/storage');
const discord = require('./lib/discord');
const stats = require('./lib/stats');
const userLimit = require('./lib/userLimit');

stats.load();
userLimit.load();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB) || 5;
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

// Access control & token budget
const EVENT_CODE = (process.env.EVENT_CODE || '').trim();
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '0', 10); // 0 = unlimited
const PER_USER_LIMIT = parseInt(process.env.PER_USER_LIMIT || '0', 10); // per-INITIAL cap, 0 = unlimited
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
// Temporarily hide the whole site (serve a maintenance page, block all APIs).
// Toggle via env: MAINTENANCE_MODE=1 (admins can still enter with ADMIN_TOKEN).
const MAINTENANCE_MODE = /^(1|true|on|yes)$/i.test((process.env.MAINTENANCE_MODE || '').trim());

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = [
  {
    // Manual style: no preset prompt. The user types their own description and
    // the server appends a face-preservation clause (see resolvePrompt).
    id: 'custom-manual',
    label: 'Your Own Prompt',
    preview: '/img/s10.jpg',
    prompt: '',
    promptVi: ''
  },
  {
    id: 'digital-toy',
    label: 'The Digital Toy',
    preview: '/img/card-digitaltoy.jpg',
    prompt:
      'A high-quality, professional 3D chibi collectible art-toy figure based on the person in this ' +
      'photo, strictly maintaining 100% identical and recognizable facial features, original skin ' +
      'tone, eyes, hairstyle and friendly expression, reimagined as an adorable big-head small-body ' +
      "chibi (blind box figure style, similar to Pop Mart). The character is an 'AI & DIGITAL WEEK' " +
      'champion, wearing a cute oversized deep navy blue hoodie with a tiny Novo logo and subtle ' +
      'futuristic data/network motifs on the chest, paired with tiny stylish blue and white ' +
      'sneakers. The full-body figure stands centered on a small glossy dark round pedestal disc ' +
      "that reads 'SPECIAL EDITION 20/10'. The entire background MUST be a dreamy holographic " +
      'iridescent pastel backdrop in lilac, lavender, sky-blue and soft pink, scattered with faint ' +
      'outlined geometric shapes (triangles, circles, squares and plus signs) and a gentle glowing ' +
      'light, filling the frame edge-to-edge. In the bottom-left corner a soft cloud-shaped badge ' +
      "reads 'novo DIGITAL WEEK'; in the bottom-right corner a pink cloud-shaped badge reads 'HAPPY " +
      "WOMEN'S DAY 20/10'; a small 'novo' wordmark sits in the top-right corner. Do NOT draw any toy " +
      'packaging box, no blind-box case, no transparent container and no office background — just ' +
      'the single figure on its pedestal over the holographic backdrop. Soft colorful volumetric ' +
      'lighting, shiny smooth plastic/resin toy materials, vibrant pastel gradients. Creative ' +
      'CGI/clay 3D render, Octane render, pop-toy art aesthetic with gentle depth of field.',
    promptVi:
      'Một mô hình chibi 3D sưu tầm chuyên nghiệp chất lượng cao dựa trên người trong ảnh, giữ nguyên ' +
      '100% đường nét khuôn mặt, tông da gốc, ánh mắt, kiểu tóc và biểu cảm thân thiện, được tái hiện ' +
      'thành nhân vật chibi đầu to mình nhỏ đáng yêu (phong cách blind box, tương tự Pop Mart). Nhân ' +
      'vật là nhà vô địch "AI & DIGITAL WEEK", mặc áo hoodie xanh navy đậm quá khổ dễ thương với logo ' +
      'Novo nhỏ và họa tiết dữ liệu/mạng lưới tương lai tinh tế trên ngực, đi giày sneaker xanh-trắng ' +
      "nhỏ xinh. Toàn thân nhân vật đứng căn giữa trên một bệ tròn tối bóng nhỏ ghi 'SPECIAL EDITION " +
      "20/10'. Toàn bộ hậu cảnh BẮT BUỘC là phông holographic óng ánh pastel mơ màng tông lilac, " +
      'lavender, xanh da trời và hồng nhạt, rải rác các hình khối viền mảnh (tam giác, tròn, vuông và ' +
      'dấu cộng) cùng ánh sáng phát quang dịu, phủ kín toàn khung. Góc dưới-trái có một badge hình mây ' +
      "mềm ghi 'novo DIGITAL WEEK'; góc dưới-phải có một badge hình mây màu hồng ghi 'HAPPY WOMEN'S " +
      "DAY 20/10'; góc trên-phải có chữ 'novo' nhỏ. TUYỆT ĐỐI không vẽ hộp bao bì đồ chơi, không hộp " +
      'blind box, không hộp trong suốt và không hậu cảnh văn phòng — chỉ có một nhân vật đứng trên bệ ' +
      'trên nền holographic. Ánh sáng thể tích mềm mại nhiều màu, chất liệu nhựa/resin bóng mượt, dải ' +
      'màu pastel rực rỡ. Kết xuất 3D CGI/clay sáng tạo, Octane render, thẩm mỹ pop-toy với độ sâu ' +
      'trường ảnh dịu.'
  },
  {
    // Card style (photoreal): the AI generates a realistic waist-up portrait on
    // the soft swirl background; renderNovoCard composites it into the same
    // "Digital Discovery Series" collectible-card frame with the user's initial.
    id: 'novo-card-real',
    label: 'Discovery Card · Photo',
    preview: '/img/card-real.jpg',
    prompt:
      'A clean, high-quality realistic studio portrait of the person in this photo, strictly ' +
      'preserving their EXACT facial features, bone structure, skin tone, hairstyle and genuine ' +
      'expression with no distortion, and keeping the SAME clothing and outfit colors as the ' +
      'original photo. Waist-up framing, centered, facing the camera with a warm friendly smile, ' +
      'hands and arms naturally visible. The full background MUST be a soft, airy, dreamy halo of ' +
      'smooth concentric light rings radiating gently outward from a luminous soft white bloom right ' +
      "behind the subject's head, in delicate pastel lilac, lavender and baby sky-blue that stay " +
      'light and desaturated. Keep it clean, minimal and elegant — NOT a busy spiral vortex, NOT ' +
      'dark or oversaturated — like a premium collectible trading-card backdrop with a gentle radial ' +
      'glow, fine soft light rays and a few delicate sparkles. Fill the entire frame edge-to-edge ' +
      'with this soft background (no plain white, no dark background), with the subject clearly ' +
      'separated from it by soft front lighting. Photorealistic, sharp focus on the face, premium ' +
      'editorial look, authentic 35mm photography. Absolutely no text, no logos, no borders, and no ' +
      'frame in the image.',
    promptVi:
      'Chân dung studio tả thực, sạch, chất lượng cao của người trong ảnh, giữ CHÍNH XÁC đường nét ' +
      'khuôn mặt, cấu trúc xương, tông da, kiểu tóc và biểu cảm chân thật không biến dạng, GIỮ NGUYÊN ' +
      'trang phục cùng màu sắc như ảnh gốc. Khung hình nửa người (tới eo), căn giữa, nhìn thẳng ống ' +
      'kính với nụ cười ấm áp thân thiện, thấy tự nhiên bàn tay và cánh tay. Toàn bộ nền BẮT BUỘC là ' +
      'vầng hào quang mềm mại, airy gồm các vòng sáng đồng tâm lan tỏa nhẹ từ một điểm sáng trắng dịu ' +
      'ngay sau đầu nhân vật, tông pastel tím lilac, lavender và xanh da trời nhạt, giữ nhạt và ít ' +
      'bão hòa. Phải sạch, tối giản, thanh lịch — KHÔNG phải xoáy ốc rối mắt, KHÔNG tối hay quá bão ' +
      'hòa — như phông thẻ sưu tập cao cấp với ánh glow lan tỏa, vài tia sáng mềm và chút lấp lánh ' +
      'tinh tế. Phủ kín toàn khung bằng nền mềm này (không nền trắng trơn, không nền tối), nhân vật ' +
      'tách biệt rõ nhờ ánh sáng trước dịu. Ảnh chân thực, lấy nét sắc vào khuôn mặt, phong cách tạp ' +
      'chí cao cấp, nhiếp ảnh 35mm chân thực. Tuyệt đối không có chữ, logo, viền hay khung trong ảnh.'
  },
  {
    // Persona card "AI Leader": a photoreal full-body standing portrait inside a
    // futuristic blue/violet scene with cute robots and floating UI. renderNovoCard
    // composites it into a portrait card with the persona title + tagline footer.
    id: 'novo-persona-leader',
    label: 'Persona Card · AI Leader',
    preview: '/img/persona-leader.jpg',
    prompt:
      'A clean, high-quality realistic FULL-BODY portrait of the person in this photo, strictly ' +
      'preserving their EXACT facial features, bone structure, skin tone, hairstyle and genuine ' +
      'expression with no distortion, and keeping the SAME clothing and outfit colors as the ' +
      'original photo. The person STANDS confidently facing the camera with a warm friendly smile, ' +
      'the ENTIRE body visible from head to feet with clear headroom above the head and the floor ' +
      'visible below the feet, sized to comfortably fit inside a square 1:1 frame. They hold a sleek ' +
      'modern laptop and raise one hand in a friendly welcoming gesture, posing as an inspiring AI ' +
      'Leader. Around them float a few cute friendly white-and-blue 3D robot assistants and glowing ' +
      'holographic UI panels, charts and tech icons. The subject stands on a softly glowing circular ' +
      'podium with concentric light rings. The full background MUST be a vibrant yet soft ' +
      'blue-to-violet gradient tech scene filled with floating pastel bubbles, holographic data ' +
      'panels and gentle glow, filling the entire frame edge-to-edge (no plain white, no dark ' +
      'background). Photorealistic subject, sharp focus on the face, premium collectible-card look. ' +
      'Absolutely no text, no logos, no borders, and no frame in the image.',
    promptVi:
      'Chân dung TOÀN THÂN tả thực, sạch, chất lượng cao của người trong ảnh, giữ CHÍNH XÁC đường nét ' +
      'khuôn mặt, cấu trúc xương, tông da, kiểu tóc và biểu cảm chân thật không biến dạng, GIỮ NGUYÊN ' +
      'trang phục cùng màu sắc như ảnh gốc. Người ĐỨNG tự tin nhìn thẳng ống kính với nụ cười ấm áp ' +
      'thân thiện, thấy TOÀN BỘ cơ thể từ đầu tới chân, chừa khoảng trống phía trên đầu và thấy sàn ' +
      'phía dưới chân, kích thước vừa vặn trong khung vuông 1:1. Tay cầm một chiếc laptop hiện đại ' +
      'mỏng nhẹ và giơ một tay chào thân thiện, tạo dáng như một AI Leader truyền cảm hứng. Xung quanh ' +
      'có vài chú robot AI 3D trắng-xanh dễ thương bay lơ lửng cùng các bảng UI ba chiều, biểu đồ và ' +
      'icon công nghệ phát sáng. Nhân vật đứng trên bục tròn phát sáng với các vòng sáng đồng tâm. ' +
      'Toàn bộ nền BẮT BUỘC là cảnh công nghệ gradient xanh dương sang tím rực rỡ mà dịu, đầy bong ' +
      'bóng pastel bay lơ lửng, bảng dữ liệu ba chiều và ánh glow nhẹ, phủ kín toàn khung (không nền ' +
      'trắng trơn, không nền tối). Nhân vật tả thực, lấy nét sắc vào khuôn mặt, phong cách thẻ sưu tập ' +
      'cao cấp. Tuyệt đối không có chữ, logo, viền hay khung trong ảnh.'
  },
  {
    // Persona card "Smart Worker": photoreal full-body standing portrait in a bright
    // productivity scene with floating UI, a blue cube and a helper robot.
    id: 'novo-persona-worker',
    label: 'Persona Card · Smart Worker',
    preview: '/img/persona-worker.jpg',
    prompt:
      'A clean, high-quality realistic FULL-BODY portrait of the person in this photo, strictly ' +
      'preserving their EXACT facial features, bone structure, skin tone, hairstyle and genuine ' +
      'expression with no distortion, and keeping the SAME clothing and outfit colors as the ' +
      'original photo. The person STANDS relaxed and confident facing the camera with a warm smile, ' +
      'the ENTIRE body visible from head to feet with clear headroom above the head and the floor ' +
      'visible below the feet, sized to comfortably fit inside a square 1:1 frame. They casually hold ' +
      'a slim laptop or tablet and give a light thumbs-up, posing as a relaxed, productive Smart ' +
      'Worker. Around them float a cute friendly white-and-blue 3D robot assistant, a glowing blue 3D ' +
      'cube, holographic UI panels, charts and task checklists. The full background MUST be a vibrant ' +
      'yet soft blue-to-violet gradient tech scene filled with floating pastel bubbles, holographic ' +
      'data panels, neon arcs and gentle glow, filling the entire frame edge-to-edge (no plain white, ' +
      'no dark background). Photorealistic subject, sharp focus on the face, premium collectible-card ' +
      'look. Absolutely no text, no logos, no borders, and no frame in the image.',
    promptVi:
      'Chân dung TOÀN THÂN tả thực, sạch, chất lượng cao của người trong ảnh, giữ CHÍNH XÁC đường nét ' +
      'khuôn mặt, cấu trúc xương, tông da, kiểu tóc và biểu cảm chân thật không biến dạng, GIỮ NGUYÊN ' +
      'trang phục cùng màu sắc như ảnh gốc. Người ĐỨNG thoải mái tự tin nhìn thẳng ống kính với nụ ' +
      'cười ấm áp, thấy TOÀN BỘ cơ thể từ đầu tới chân, chừa khoảng trống phía trên đầu và thấy sàn ' +
      'phía dưới chân, kích thước vừa vặn trong khung vuông 1:1. Tay cầm nhẹ một chiếc laptop hoặc ' +
      'tablet mỏng và giơ ngón tay cái, tạo dáng như một Smart Worker làm việc hiệu quả và thư thái. ' +
      'Xung quanh có một chú robot AI 3D trắng-xanh dễ thương bay lơ lửng, một khối lập phương 3D xanh ' +
      'phát sáng, các bảng UI ba chiều, biểu đồ và danh sách công việc. Toàn bộ nền BẮT BUỘC là cảnh ' +
      'công nghệ gradient xanh dương sang tím rực rỡ mà dịu, đầy bong bóng pastel bay lơ lửng, bảng dữ ' +
      'liệu ba chiều, các cung neon và ánh glow nhẹ, phủ kín toàn khung (không nền trắng trơn, không ' +
      'nền tối). Nhân vật tả thực, lấy nét sắc vào khuôn mặt, phong cách thẻ sưu tập cao cấp. Tuyệt ' +
      'đối không có chữ, logo, viền hay khung trong ảnh.'
  },
  {
    // Persona card "Digital Explorer": photoreal full-body standing portrait in a
    // dreamy pastel sky scene with a rocket, clouds and floating data panels.
    id: 'novo-persona-explorer',
    label: 'Persona Card · Digital Explorer',
    preview: '/img/persona-explorer.jpg',
    prompt:
      'A clean, high-quality realistic FULL-BODY portrait of the person in this photo, strictly ' +
      'preserving their EXACT facial features, bone structure, skin tone, hairstyle and genuine ' +
      'expression with no distortion, and keeping the SAME clothing and outfit colors as the ' +
      'original photo. The person STANDS adventurously facing the camera with a bright curious smile, ' +
      'the ENTIRE body visible from head to feet with clear headroom above the head and the floor ' +
      'visible below the feet, sized to comfortably fit inside a square 1:1 frame. They point forward ' +
      'or hold a small glowing device, posing as a curious Digital Explorer ready to discover. Beside ' +
      'them float a cute friendly white-and-blue 3D robot assistant, a small cartoon rocket, soft ' +
      'clouds, holographic UI panels, a pie chart and tech icons. The full background MUST be a dreamy ' +
      'soft blue-violet-to-lavender gradient sky scene filled with floating pastel bubbles, gentle ' +
      'clouds, neon swirl arcs and a soft glow, filling the entire frame edge-to-edge (no plain ' +
      'white, no dark background). Photorealistic subject, sharp focus on the face, premium ' +
      'collectible-card look. Absolutely no text, no logos, no borders, and no frame in the image.',
    promptVi:
      'Chân dung TOÀN THÂN tả thực, sạch, chất lượng cao của người trong ảnh, giữ CHÍNH XÁC đường nét ' +
      'khuôn mặt, cấu trúc xương, tông da, kiểu tóc và biểu cảm chân thật không biến dạng, GIỮ NGUYÊN ' +
      'trang phục cùng màu sắc như ảnh gốc. Người ĐỨNG đầy phiêu lưu nhìn thẳng ống kính với nụ cười ' +
      'tươi tò mò, thấy TOÀN BỘ cơ thể từ đầu tới chân, chừa khoảng trống phía trên đầu và thấy sàn ' +
      'phía dưới chân, kích thước vừa vặn trong khung vuông 1:1. Tay chỉ về phía trước hoặc cầm một ' +
      'thiết bị nhỏ phát sáng, tạo dáng như một Digital Explorer tò mò sẵn sàng khám phá. Bên cạnh có ' +
      'một chú robot AI 3D trắng-xanh dễ thương bay lơ lửng, một tên lửa hoạt hình nhỏ, mây mềm, các ' +
      'bảng UI ba chiều, biểu đồ tròn và icon công nghệ. Toàn bộ nền BẮT BUỘC là cảnh bầu trời gradient ' +
      'xanh dương - tím - lavender mơ màng dịu, đầy bong bóng pastel bay lơ lửng, mây nhẹ, các cung ' +
      'neon xoáy và ánh glow nhẹ, phủ kín toàn khung (không nền trắng trơn, không nền tối). Nhân vật ' +
      'tả thực, lấy nét sắc vào khuôn mặt, phong cách thẻ sưu tập cao cấp. Tuyệt đối không có chữ, ' +
      'logo, viền hay khung trong ảnh.'
  },
  {
    // Team card (chibi): preserves EVERY face in a group photo, stylised as cute
    // figures on a purple confetti stage. Composited into the landscape team card.
    id: 'novo-team-chibi',
    label: 'Team Discovery Card (Chibi)',
    preview: '/img/team-chibi.jpg',
    prompt:
      'Turn this group photo into a cute, high-quality 3D chibi cartoon. Transform EVERY person into ' +
      'an adorable chibi character with a BIG head, small body, big sparkly expressive eyes and ' +
      'smooth glossy toy skin, while keeping each person\u2019s recognizable face, hairstyle, skin ' +
      'tone and the SAME clothing and outfit colors as in the photo. Keep the EXACT same number of ' +
      'people and their left-to-right order — do NOT add, remove, merge, duplicate or swap anyone. ' +
      'Arrange them standing together as a cheerful team in ONE horizontal row as a WIDE landscape ' +
      'composition, every person\u2019s full body visible from head to feet with clear headroom ' +
      'above and the stage floor below. The full background MUST be a vibrant purple-to-violet ' +
      'gradient stage with a soft glowing light beam, a subtle perspective floor, and scattered ' +
      'pastel geometric confetti (outlined triangles, circles, squares and plus signs) in pink, blue ' +
      'and cyan. Pop Mart / Pixar style 3D render, clean crisp cartoon look, smooth shading, bright ' +
      'playful lighting. Absolutely no text, no logos, no borders, and no frame in the image.',
    promptVi:
      'Biến ảnh nhóm này thành 3D chibi cartoon dễ thương chất lượng cao. Chuyển MỌI người thành nhân ' +
      'vật chibi đáng yêu với ĐẦU TO, mình nhỏ, mắt to long lanh và da nhựa bóng mượt, đồng thời giữ ' +
      'khuôn mặt nhận ra được, kiểu tóc, tông da và GIỮ NGUYÊN trang phục cùng màu sắc của từng người ' +
      'như trong ảnh. Giữ ĐÚNG số lượng người và thứ tự trái-phải — KHÔNG thêm, bớt, gộp, nhân bản hay ' +
      'hoán đổi ai. Xếp mọi người đứng chung thành một team vui tươi thành MỘT hàng ngang theo bố cục ' +
      'NGANG, thấy nguyên người từ đầu tới chân với khoảng trống phía trên đầu và sàn phía dưới. Toàn ' +
      'bộ nền BẮT BUỘC là sân khấu gradient tím-tím violet với dải sáng dịu, sàn phối cảnh nhẹ và các ' +
      'hình học confetti pastel (tam giác, tròn, vuông, dấu cộng viền) màu hồng, xanh dương, xanh ' +
      'cyan. Phong cách 3D Pop Mart / Pixar, nét cartoon sạch sắc, đổ bóng mượt, ánh sáng tươi vui. ' +
      'Tuyệt đối không có chữ, logo, viền hay khung trong ảnh.'
  },
  {
    // Team card (photoreal): keeps every real face in a group photo on the same
    // purple confetti stage. Composited into the landscape team card.
    id: 'novo-team-real',
    label: 'Team Discovery Card (Photo)',
    preview: '/img/team-real.jpg',
    prompt:
      'A clean, high-quality realistic group portrait of ALL the people in this photo, strictly ' +
      'preserving EACH person\u2019s EXACT facial features, bone structure, skin tone, hairstyle and ' +
      'the SAME clothing and outfit colors as the original photo — do not add, remove, merge or swap ' +
      'any person, keep the same number of people and their left-to-right order, no distortion. The ' +
      'team stands together in a natural group pose, arranged in ONE horizontal row as a WIDE ' +
      'landscape composition, every person\u2019s FULL body visible from head to feet with clear ' +
      'headroom above and the stage floor below, sized to comfortably fit a wide 2.4:1 frame. The ' +
      'full background MUST be a vibrant purple-to-violet gradient stage with a soft glowing light ' +
      'beam, a subtle perspective floor, and scattered pastel geometric confetti (outlined triangles, ' +
      'circles, squares and plus signs) in pink, blue and cyan. Photorealistic, sharp focus on the ' +
      'faces, premium editorial look, authentic 35mm photography. Absolutely no text, no logos, no ' +
      'borders, and no frame in the image.',
    promptVi:
      'Chân dung nhóm tả thực, sạch, chất lượng cao của TẤT CẢ mọi người trong ảnh, giữ CHÍNH XÁC ' +
      'đường nét khuôn mặt, cấu trúc xương, tông da, kiểu tóc và GIỮ NGUYÊN trang phục cùng màu sắc của ' +
      'từng người như ảnh gốc — không thêm, bớt, gộp hay hoán đổi người, giữ đúng số lượng và thứ tự ' +
      'trái-phải, không biến dạng. Cả team đứng chung dáng tự nhiên, xếp thành MỘT hàng ngang theo bố ' +
      'cục NGANG, thấy NGUYÊN người từ đầu tới chân với khoảng trống phía trên đầu và sàn phía dưới, ' +
      'cỡ vừa khít khung ngang 2.4:1. ' +
      'Toàn bộ nền BẮT BUỘC là sân khấu gradient tím-tím violet với dải sáng dịu, sàn phối cảnh nhẹ và ' +
      'các hình học confetti pastel (tam giác, tròn, vuông, dấu cộng viền) màu hồng, xanh dương, xanh ' +
      'cyan. Ảnh chân thực, lấy nét sắc vào khuôn mặt, phong cách tạp chí cao cấp, nhiếp ảnh 35mm chân ' +
      'thực. Tuyệt đối không có chữ, logo, viền hay khung trong ảnh.'
  },
  {
    // Card style: the AI only generates a waist-up stylized portrait on a swirl
    // gradient background. The client (renderNovoCard) composites it into a fixed
    // "Digital Discovery Series" collectible-card frame with the user's initial.
    id: 'novo-card-anime',
    label: 'Discovery Card · Anime',
    preview: '/img/card-anime.jpg',
    prompt:
      'A vibrant, high-quality 2D anime / semi-realistic stylized portrait of the person in this ' +
      'photo, strictly maintaining 100% identical and recognizable facial features, hairstyle, skin ' +
      'tone, and the SAME clothing and outfit colors as the original photo. Waist-up framing, ' +
      'centered, facing the camera with a warm friendly smile, hands and arms naturally visible. ' +
      'The full background MUST be a soft, airy, dreamy halo of smooth concentric light rings ' +
      "radiating gently outward from a luminous soft white bloom right behind the subject's head, in " +
      'delicate pastel lilac, lavender and baby sky-blue that stay light and desaturated. Keep it ' +
      'clean, minimal and elegant — NOT a busy spiral vortex, NOT dark or oversaturated — like a ' +
      'premium collectible trading-card backdrop with a gentle radial glow, fine soft light rays and ' +
      'a few delicate sparkles. Fill the entire frame edge-to-edge with this soft background (no ' +
      'plain white, no dark background), with the subject clearly separated from it by soft front ' +
      'lighting. Clean crisp anime cel-shading, smooth gradients, polished digital illustration, ' +
      'bright airy lighting. Absolutely no text, no logos, no borders, and no frame in the image.',
    promptVi:
      'Chân dung stylize 2D anime / bán tả thực chất lượng cao của người trong ảnh, giữ nguyên 100% ' +
      'đường nét khuôn mặt, kiểu tóc, tông da và GIỮ NGUYÊN trang phục cùng màu sắc như ảnh gốc. Khung ' +
      'hình nửa người (tới eo), căn giữa, nhìn thẳng ống kính với nụ cười ấm áp thân thiện, thấy tự ' +
      'nhiên bàn tay và cánh tay. Toàn bộ nền BẮT BUỘC là vầng hào quang mềm mại, airy gồm các vòng ' +
      'sáng đồng tâm lan tỏa nhẹ từ một điểm sáng trắng dịu ngay sau đầu nhân vật, tông pastel tím ' +
      'lilac, lavender và xanh da trời nhạt, giữ nhạt và ít bão hòa. Phải sạch, tối giản, thanh lịch ' +
      '— KHÔNG phải xoáy ốc rối mắt, KHÔNG tối hay quá bão hòa — như phông thẻ sưu tập cao cấp với ' +
      'ánh glow lan tỏa, vài tia sáng mềm và chút lấp lánh tinh tế. Phủ kín toàn khung bằng nền mềm ' +
      'này (không nền trắng trơn, không nền tối), nhân vật tách biệt rõ nhờ ánh sáng trước dịu. ' +
      'Cel-shading anime sắc nét, chuyển màu mượt, minh họa số tinh tế, ánh sáng tươi sáng. Tuyệt ' +
      'đối không có chữ, logo, viền hay khung trong ảnh.'
  },
  {
    id: 'digital-leader',
    label: 'Empowered Digital Leader',
    preview: '/img/s1.jpg',
    prompt:
      'A high-end editorial corporate portrait of the person in this photo, strictly ' +
      'maintaining 100% identical facial features, natural skin tone, eyes, and genuine ' +
      'expression without distortion. The subject poses as an Empowered Digital Leader during ' +
      'Novo Digital Week, exuding confidence and intellect, looking directly at the ' +
      'camera with a subtle, warm smile. Dressed in a bespoke tailored Novo deep navy ' +
      'blue blazer with a subtle metallic company pin on the lapel, layered over an elegant silk ' +
      'white or light-cream inner blouse/shirt. Naturally holding a sleek digital tablet and an ' +
      'executive leather portfolio notebook. Set in a grand, state-of-the-art corporate innovation ' +
      'hub with high ceilings, vast glass architecture, and subtle blurred displays showing ' +
      'holographic medical charts, DNA structures, and digital analytics. Prominent yet tasteful ' +
      "event branding with 'DIGITAL WEEK' and 'EMPOWERING HEALTHCARE' standees, paired with refined " +
      'navy, white, and silver balloons and corporate floral accents. Soft daylight through ' +
      'expansive floor-to-ceiling glass blended with modern studio rim lighting. Shallow depth of ' +
      'field, creamy bokeh, clean 8k photorealistic resolution, authentic 35mm photography aesthetic.',
    promptVi:
      'Chân dung doanh nhân cao cấp theo phong cách tạp chí của người trong ảnh, giữ nguyên 100% ' +
      'đường nét khuôn mặt, tông da tự nhiên, ánh mắt và biểu cảm chân thật, không biến dạng. Nhân vật ' +
      'xuất hiện như một Nhà lãnh đạo số bản lĩnh trong Tuần lễ Số Novo, toát lên sự tự tin và ' +
      'trí tuệ, nhìn thẳng vào ống kính với nụ cười ấm áp tinh tế. Mặc blazer may đo màu xanh navy đậm ' +
      'của Novo, đính huy hiệu kim loại nhỏ trên ve áo, bên trong là áo lụa trắng hoặc kem thanh ' +
      'lịch. Tay cầm một chiếc máy tính bảng mỏng nhẹ và sổ da điều hành. Bối cảnh là trung tâm đổi mới ' +
      'doanh nghiệp hiện đại với trần cao, kiến trúc kính rộng lớn, phía sau mờ ảo là các màn hình chiếu ' +
      "biểu đồ y khoa ảnh ba chiều, cấu trúc DNA và phân tích dữ liệu số. Có standee sự kiện 'DIGITAL " +
      "WEEK' và 'EMPOWERING HEALTHCARE' tinh tế, cùng bóng bay navy, trắng, bạc và hoa trang trí doanh " +
      'nghiệp. Ánh sáng ban ngày dịu qua kính sàn-tới-trần kết hợp ánh viền studio hiện đại. Độ sâu ' +
      'trường ảnh nông, bokeh mịn, độ phân giải 8k chân thực, thẩm mỹ nhiếp ảnh 35mm chuẩn mực.'
  },
  {
    id: 'nordic-grace',
    label: "Vietnamese Women's Day Celebration (20/10)",
    preview: '/img/s2.jpg',
    prompt:
      'A natural-light corporate event portrait of the person in this photo, strictly preserving ' +
      'their authentic facial identity, bone structure, and facial expression. The subject stands ' +
      "in a vibrant corporate office lobby during Novo's Vietnamese Women's Day (October 20) " +
      'celebration. Wearing an elegant navy blue blazer over a soft pastel pink or cream dress shirt, ' +
      'gracefully holding a delicate bouquet of fresh pastel roses, lisianthus, and lush greenery ' +
      'tied with a neat navy blue ribbon. Looking at the camera with a warm, welcoming smile. The ' +
      'modern glass-and-steel lobby is tastefully decorated for an office company party: branded ' +
      "backdrops reading 'Chúc mừng Ngày Phụ nữ Việt Nam 20-10' and 'Happy Women's Day 20/10', " +
      "standing 'Digital Week' roll-up banners, and clusters of corporate blue and white balloons. " +
      'Blurred background shows corporate colleagues casually networking, completely free of any ' +
      'wedding drapes, romantic arches, or wedding-like motifs. Bright, diffused daylight through ' +
      'lobby windows, shallow depth of field, sharp subject focus, realistic photographic texture.',
    promptVi:
      'Chân dung sự kiện doanh nghiệp dưới ánh sáng tự nhiên của người trong ảnh, giữ nguyên tuyệt đối ' +
      'bản sắc khuôn mặt, cấu trúc xương và biểu cảm thật. Nhân vật đứng trong sảnh văn phòng doanh ' +
      'nghiệp rực rỡ trong dịp Novo mừng Ngày Phụ nữ Việt Nam (20/10). Mặc blazer xanh navy ' +
      'thanh lịch bên ngoài áo sơ mi hồng pastel hoặc kem nhẹ nhàng, tay nâng nhẹ một bó hoa tươi gồm ' +
      'hồng pastel, cát tường và lá xanh, buộc nơ xanh navy gọn gàng. Nhìn vào ống kính với nụ cười ấm ' +
      'áp, thân thiện. Sảnh kính-và-thép hiện đại được trang trí tinh tế cho một buổi tiệc công ty: phông ' +
      "nền thương hiệu ghi 'Chúc mừng Ngày Phụ nữ Việt Nam 20-10' và 'Happy Women's Day 20/10', các " +
      "standee cuộn 'Digital Week', cùng các chùm bóng bay xanh và trắng của công ty. Hậu cảnh mờ là các " +
      'đồng nghiệp đang giao lưu, hoàn toàn không có rèm cưới, cổng hoa lãng mạn hay họa tiết kiểu đám ' +
      'cưới. Ánh sáng ban ngày khuếch tán qua cửa sổ sảnh, độ sâu trường ảnh nông, chủ thể sắc nét, kết ' +
      'cấu ảnh chân thực.'
  },
  {
    id: 'future-healthcare',
    label: 'Future Healthcare & AI Innovation',
    preview: '/img/s3.jpg',
    prompt:
      'A visionary future healthcare portrait of the person in this photo, accurately preserving ' +
      'their identical facial features, eyes, and natural skin texture. Dressed in a sleek, ' +
      'smart-casual corporate blazer in Novo True Blue (#001965) over a clean white shirt, ' +
      'featuring a discreet logo on the chest. Set inside a cutting-edge healthcare technology ' +
      'laboratory and digital innovation center, strictly devoid of any party decorations or flowers. ' +
      'The background features glowing medical data monitors, floating network connection nodes, ' +
      "smart health visualization screens, and frosted glass partitions with faint 'FUTURE HEALTHCARE' " +
      'typography. Controlled cool-toned interior illumination with soft blue and teal ambient rim ' +
      'lights. Sharp focus on the subject, balanced studio depth of field, premium editorial look, ' +
      'photorealistic 8k render.',
    promptVi:
      'Chân dung y tế tương lai đầy tầm nhìn của người trong ảnh, giữ chính xác đường nét khuôn mặt, ' +
      'ánh mắt và kết cấu da tự nhiên. Mặc blazer doanh nghiệp smart-casual màu True Blue của Novo ' +
      '(#001965) bên ngoài áo sơ mi trắng, có logo nhỏ kín đáo trên ngực. Bối cảnh bên trong một ' +
      'phòng thí nghiệm công nghệ y tế tiên tiến và trung tâm đổi mới số, tuyệt đối không có trang trí ' +
      'tiệc tùng hay hoa. Hậu cảnh là các màn hình dữ liệu y khoa phát sáng, các nút kết nối mạng lơ ' +
      "lửng, màn hình trực quan hóa sức khỏe thông minh và vách kính mờ với dòng chữ 'FUTURE HEALTHCARE' " +
      'thấp thoáng. Ánh sáng nội thất tông lạnh được kiểm soát với ánh viền xanh dương và xanh ngọc dịu. ' +
      'Lấy nét sắc vào chủ thể, độ sâu trường ảnh cân đối, phong cách tạp chí cao cấp, kết xuất 8k chân ' +
      'thực.'
  },
  {
    id: 'driving-change',
    label: 'Driving Change & Dynamic Collaboration',
    preview: '/img/s4.jpg',
    prompt:
      'An energetic, candid lifestyle corporate portrait of the person in this photo, preserving ' +
      'authentic face shape, smile, and natural facial proportions. Wearing a casual corporate navy ' +
      'blue polo shirt with a subtle chest logo. Positioned in a bustling, open-concept collaborative ' +
      'workspace and innovation lounge. Warm daylight streams through expansive windows, illuminating ' +
      'an interactive company culture atmosphere: blurred colleagues brainstorming at touchscreens, ' +
      "event display boards with 'DRIVING CHANGE' and 'DIGITAL WEEK', and modest company-colored " +
      'decorative balloons. Authentic documentary feel, dynamic yet professional, shallow depth of ' +
      'field, sharp eye focus, crisp 35mm camera aesthetics.',
    promptVi:
      'Chân dung doanh nghiệp đời thường, tràn năng lượng và tự nhiên của người trong ảnh, giữ nguyên ' +
      'dáng mặt, nụ cười và tỉ lệ khuôn mặt thật. Mặc áo polo doanh nghiệp xanh navy thường ngày với logo ' +
      'nhỏ trên ngực. Đứng trong không gian làm việc mở sôi động và khu lounge đổi mới. Ánh sáng ban ngày ' +
      'ấm áp tràn qua các khung cửa sổ rộng, làm bật không khí văn hóa công ty tương tác: phía sau mờ là ' +
      "đồng nghiệp đang thảo luận bên màn hình cảm ứng, các bảng sự kiện ghi 'DRIVING CHANGE' và 'DIGITAL " +
      "WEEK', cùng vài quả bóng bay trang trí màu thương hiệu. Cảm giác tư liệu chân thực, năng động nhưng " +
      'chuyên nghiệp, độ sâu trường ảnh nông, lấy nét sắc vào ánh mắt, thẩm mỹ máy ảnh 35mm sắc nét.'
  },
  {
    id: 'webtoon-weekday',
    label: 'Webtoon Weekday',
    hidden: true,
    preview: '/img/s6.jpg',
    prompt:
      'A vibrant, high-quality 2D anime/manhwa Webtoon-style illustration of the person in this ' +
      'photo, strictly maintaining 100% identical and recognizable facial features, hairstyle, and ' +
      'friendly expression in an anime/manhwa aesthetic. The subject is depicted in a lively, candid ' +
      "office scenario for 'Novo Digital Week'. Wearing a stylish, relaxed-fit navy blue " +
      'corporate-casual shirt with a tiny brand emblem on the chest, carrying a modern digital tablet ' +
      'and a keycard lanyard. Naturally looking at the camera with a cheerful, energetic Gen-Z smile. ' +
      "Set in a colorful, hand-drawn anime office lobby filled with digital screens, 'DIGITAL WEEK " +
      "20/10' and 'HAPPY WOMEN'S DAY!' banner decorations, playful tech icons, balloons, confetti, and " +
      'comic-style background staff. The artwork features crisp cel-shading, rich pastel and navy blue ' +
      'palettes, expressive action lines, and soft overlay glows. A cinematic Webtoon/Manhwa panel ' +
      'composition with colorful sparkles and digital particles.',
    promptVi:
      'Một minh họa 2D phong cách anime/manhwa Webtoon sống động, chất lượng cao của người trong ảnh, ' +
      'giữ nguyên 100% đường nét khuôn mặt, kiểu tóc và biểu cảm thân thiện dễ nhận ra theo thẩm mỹ ' +
      'anime/manhwa. Nhân vật được khắc họa trong một khung cảnh văn phòng sống động, tự nhiên cho "Novo ' +
      'Digital Week". Mặc áo sơ mi doanh nghiệp xanh navy form rộng thời trang với biểu tượng ' +
      'thương hiệu nhỏ trên ngực, cầm máy tính bảng hiện đại và dây đeo thẻ. Nhìn vào ống kính với nụ ' +
      'cười Gen-Z vui tươi, năng động. Bối cảnh là sảnh văn phòng anime nhiều màu vẽ tay đầy màn hình số, ' +
      "trang trí banner 'DIGITAL WEEK 20/10' và 'HAPPY WOMEN'S DAY!', các biểu tượng công nghệ vui nhộn, " +
      'bóng bay, confetti và nhân vật nền phong cách truyện tranh. Tác phẩm có cel-shading sắc nét, bảng ' +
      'màu pastel và xanh navy phong phú, các đường chuyển động biểu cảm và lớp ánh sáng phủ dịu. Bố cục ' +
      'khung Webtoon/Manhwa điện ảnh với tia lấp lánh nhiều màu và hạt số.'
  },
  {
    id: 'arcade-hero',
    label: 'Retro Arcade Hero',
    preview: '/img/s7.jpg',
    prompt:
      'A playful retro arcade-style portrait of the person in this photo, strictly preserving their ' +
      'authentic facial identity, bone structure, and expression. Reimagined as a cheerful 80s-90s ' +
      'video-game champion inside a glowing neon arcade. Wearing a navy blue bomber jacket with a tiny ' +
      'Novo emblem. Surrounded by a retro arcade cabinet, pixel-art power-ups, floating coins, ' +
      "and a glowing scoreboard reading 'DIGITAL WEEK - HIGH SCORE'. Vibrant neon blue, magenta, and " +
      'cyan lighting, subtle CRT scanlines, playful pixel particles, fun energetic mood, crisp ' +
      'high-quality render blending the photoreal face with a stylized arcade background.',
    promptVi:
      'Chân dung phong cách arcade cổ điển vui nhộn của người trong ảnh, giữ nguyên tuyệt đối bản sắc ' +
      'khuôn mặt, cấu trúc xương và biểu cảm. Được tái hiện thành nhà vô địch game những năm 80-90 vui ' +
      'tươi bên trong một phòng arcade đèn neon rực sáng. Mặc áo bomber xanh navy với biểu tượng Novo ' +
      'nhỏ. Xung quanh là máy arcade cổ điển, các vật phẩm pixel-art, đồng xu lơ lửng và bảng ' +
      "điểm phát sáng ghi 'DIGITAL WEEK - HIGH SCORE'. Ánh đèn neon xanh dương, hồng magenta và xanh " +
      'cyan rực rỡ, các đường scanline CRT nhẹ, hạt pixel vui nhộn, không khí vui tươi tràn năng lượng, ' +
      'kết xuất chất lượng cao sắc nét hòa quyện khuôn mặt chân thực với hậu cảnh arcade cách điệu.'
  },
  {
    id: 'super-digital',
    label: 'Digital Superhero',
    hidden: true,
    preview: '/img/s8.jpg',
    prompt:
      'A fun, uplifting comic-book superhero portrait of the person in this photo, strictly keeping ' +
      'their identical facial features, eyes, and confident friendly smile. Dressed as a modern ' +
      'digital health guardian in a sleek navy blue and white hero suit with a glowing emblem on the ' +
      'chest and a light cape, striking a cheerful heroic pose. Behind them, a bright futuristic city ' +
      "skyline with floating holographic health shields and a banner reading 'DIGITAL WEEK HERO'. " +
      'Dynamic comic action lines, vivid colors, soft heroic rim light, playful energetic atmosphere, ' +
      'high-quality semi-realistic comic render.',
    promptVi:
      'Chân dung siêu anh hùng phong cách truyện tranh vui tươi, tràn cảm hứng của người trong ảnh, giữ ' +
      'nguyên tuyệt đối đường nét khuôn mặt, ánh mắt và nụ cười tự tin thân thiện. Hóa thân thành người ' +
      'bảo vệ sức khỏe số hiện đại trong bộ giáp anh hùng xanh navy và trắng mượt mà với biểu tượng phát ' +
      'sáng trên ngực và áo choàng nhẹ, tạo dáng anh hùng vui tươi. Phía sau là đường chân trời thành ' +
      "phố tương lai rực sáng với các khiên sức khỏe ảnh ba chiều lơ lửng và banner ghi 'DIGITAL WEEK " +
      "HERO'. Các đường chuyển động truyện tranh năng động, màu sắc rực rỡ, ánh viền anh hùng dịu, không " +
      'khí vui tươi tràn năng lượng, kết xuất truyện tranh bán chân thực chất lượng cao.'
  },
  {
    id: 'party-photobooth',
    label: 'Party Photobooth',
    hidden: true,
    preview: '/img/s9.jpg',
    prompt:
      'A joyful party photo-booth portrait of the person in this photo, strictly preserving their ' +
      'authentic face, skin tone, and happy expression. Laughing cheerfully at a festive corporate ' +
      'celebration, wearing a smart-casual navy outfit with a fun paper party hat and playful ' +
      'oversized props. Colorful confetti, balloons, and streamers fill the air; a bright backdrop ' +
      "reads 'NOVO DIGITAL WEEK' with sparkling bokeh lights. Warm, lively party lighting, " +
      'candid spontaneous mood, shallow depth of field, vibrant friendly colors, crisp photorealistic ' +
      '35mm look.',
    promptVi:
      'Chân dung photo-booth tiệc tùng vui nhộn của người trong ảnh, giữ nguyên tuyệt đối khuôn mặt, ' +
      'tông da và biểu cảm hạnh phúc. Đang cười sảng khoái trong một buổi tiệc công ty rộn ràng, mặc ' +
      'trang phục navy smart-casual với mũ giấy tiệc vui nhộn và các đạo cụ quá khổ ngộ nghĩnh. Confetti ' +
      "nhiều màu, bóng bay và dải kim tuyến bay đầy không gian; phông nền sáng ghi 'NOVO DIGITAL " +
      "WEEK' với ánh bokeh lấp lánh. Ánh sáng tiệc ấm áp, sống động, không khí tự nhiên ngẫu hứng, độ sâu " +
      'trường ảnh nông, màu sắc thân thiện rực rỡ, phong cách 35mm chân thực sắc nét.'
  },
  {
    id: 'chibi-cutie',
    label: 'Chibi Cutie',
    preview: '/img/s11.jpg',
    prompt:
      'A cute hand-drawn chibi character version of the person in this photo, strictly keeping ' +
      'their recognizable facial features, hairstyle, and friendly expression in an adorable chibi ' +
      'art style with a big head, small rounded body, and large sparkling eyes. Wearing a cozy deep ' +
      'navy blue Novo hoodie with a tiny logo on the chest, giving a cheerful peace sign. Set ' +
      'against a soft pastel background decorated with playful "DIGITAL WEEK" and "20/10" stickers, ' +
      'tiny hearts, stars, and confetti. Clean kawaii illustration, smooth cel-shading, bright pastel ' +
      'colors, crisp outlines, high-quality 2D cartoon render. Keep the same face.',
    promptVi:
      'Phiên bản nhân vật chibi vẽ tay dễ thương của người trong ảnh, giữ nguyên đường nét khuôn mặt, ' +
      'kiểu tóc và biểu cảm thân thiện dễ nhận ra theo phong cách chibi đáng yêu với đầu to, thân nhỏ ' +
      'tròn trịa và đôi mắt to long lanh. Mặc áo hoodie xanh navy đậm Novo ấm áp với logo nhỏ ' +
      'trên ngực, tạo dáng giơ tay chữ V vui tươi. Bối cảnh nền pastel nhẹ nhàng trang trí sticker ' +
      '"DIGITAL WEEK" và "20/10" vui nhộn, trái tim nhỏ, ngôi sao và confetti. Minh họa kawaii sạch sẽ, ' +
      'cel-shading mượt, màu pastel tươi sáng, nét vẽ sắc gọn, kết xuất hoạt hình 2D chất lượng cao. ' +
      'Giữ nguyên khuôn mặt.'
  },
  {
    id: 'ao-dai-heritage',
    label: 'Vietnamese Áo Dài Elegance',
    preview: '/img/s12.jpg',
    prompt:
      'An elegant studio portrait of the person in this photo, strictly preserving their exact facial ' +
      'features, skin tone, and genuine expression. Gracefully wearing a refined traditional Vietnamese ' +
      'áo dài in deep navy blue with subtle white-and-silver floral embroidery echoing the Novo ' +
      'palette, standing with poise and a warm gentle smile. Set in a tasteful scene with soft blossoms ' +
      '(white lotus or peach/apricot flowers), warm creamy bokeh, and a discreet "DIGITAL WEEK 20/10" ' +
      'accent in the background. Soft natural window light, shallow depth of field, premium editorial ' +
      'fashion photography, photorealistic 8k resolution, authentic 35mm look. Keep the same face.',
    promptVi:
      'Chân dung studio thanh lịch của người trong ảnh, giữ nguyên tuyệt đối đường nét khuôn mặt, tông ' +
      'da và biểu cảm chân thật. Duyên dáng trong tà áo dài truyền thống Việt Nam màu xanh navy đậm với ' +
      'họa tiết hoa thêu trắng-bạc tinh tế hòa cùng tông màu Novo, dáng đứng thanh thoát và nụ ' +
      'cười ấm áp dịu dàng. Bối cảnh trang nhã với hoa nhẹ nhàng (sen trắng hoặc hoa đào/mai), ánh bokeh ' +
      'ấm mịn và điểm nhấn "DIGITAL WEEK 20/10" kín đáo phía sau. Ánh sáng cửa sổ tự nhiên dịu, độ sâu ' +
      'trường ảnh nông, nhiếp ảnh thời trang tạp chí cao cấp, độ phân giải 8k chân thực, phong cách 35mm. ' +
      'Giữ nguyên khuôn mặt.'
  }
];

// Card styles composite the portrait/group into a fixed frame on the client. For
// these we attach a cropped background patch (from the sample cards) as a second
// reference image so Gemini reproduces the exact backdrop look consistently.
// Single cards use a lavender swirl; team cards use a purple stage with confetti.
const CARD_STYLE_IDS = new Set([
  'novo-card-anime', 'novo-card-real', 'novo-team-chibi', 'novo-team-real',
  'novo-persona-leader', 'novo-persona-worker', 'novo-persona-explorer'
]);
const CARD_REF_KEY = {
  'novo-card-anime': 'single',
  'novo-card-real': 'single',
  'novo-team-chibi': 'team',
  'novo-team-real': 'team',
  'novo-persona-leader': 'leader',
  'novo-persona-worker': 'worker',
  'novo-persona-explorer': 'explorer'
};
// Force Gemini's output aspect to match each card's window so nothing is cropped:
// single cards use a ~square window (1:1), team cards use a wide window (16:9).
const CARD_ASPECT = {
  'novo-card-anime': '1:1',
  'novo-card-real': '1:1',
  'novo-team-chibi': '16:9',
  'novo-team-real': '16:9',
  'novo-persona-leader': '1:1',
  'novo-persona-worker': '1:1',
  'novo-persona-explorer': '1:1',
  // The Digital Toy card is a tall holographic collectible (Picture0.png): portrait 3:4.
  'digital-toy': '3:4'
};
const CARD_BG_INSTRUCTION =
  ' IMPORTANT: a SECOND reference image is provided — use it strictly as the exact ' +
  'style, color and texture reference for the background only. Recreate that same ' +
  'background filling the whole frame. Do NOT copy any person, clothing, border, ' +
  'frame or text from it.';

function loadCardRef(file) {
  try {
    const bytes = fs.readFileSync(path.join(__dirname, 'assets', file));
    return { mimeType: 'image/jpeg', data: bytes.toString('base64') };
  } catch (err) {
    console.warn('[card-bg] reference not loaded (' + file + '):', err.message);
    return null;
  }
}
const CARD_BG_REFS = {
  single: loadCardRef('card-bg-ref.jpg'),
  team: loadCardRef('card-bg-team.jpg'),
  leader: loadCardRef('card-bg-leader.jpg'),
  worker: loadCardRef('card-bg-worker.jpg'),
  explorer: loadCardRef('card-bg-explorer.jpg')
};
function cardRefFor(styleId) {
  const key = CARD_REF_KEY[styleId];
  return key ? CARD_BG_REFS[key] : null;
}

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Team styles turn a whole group into one chibi/photo row. The image model tends
// to hallucinate or drop a person, so we first ask a cheap text model to COUNT
// the people, then ground the generation prompt on that exact number.
const TEAM_STYLE_IDS = new Set(['novo-team-chibi', 'novo-team-real']);

async function countPeopleInPhoto(parsed) {
  try {
    const resp = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: parsed.mimeType, data: parsed.data } },
          { text: 'Count how many distinct real people appear in this photo. Reply with ONLY a single integer, nothing else.' }
        ]
      }]
    });
    logGenCost('count', 'gemini-3.8-flash', resp.usageMetadata);
    const text = (resp.text || '').trim();
    const m = text.match(/\d+/);
    const n = m ? parseInt(m[0], 10) : 0;
    return n > 0 && n <= 30 ? n : 0;
  } catch (err) {
    console.error('[count] Error:', err.message || err);
    return 0;
  }
}

function peopleCountClause(n) {
  return ' CRITICAL COUNT: there are EXACTLY ' + n + ' people in the original photo. ' +
    'Render EXACTLY ' + n + ' figures — the same ' + n + ' people, one per person, in the ' +
    'same left-to-right order. Do NOT add, invent, duplicate, merge or drop anyone; the output ' +
    'must contain exactly ' + n + ' figures, no more and no fewer.';
}

// All styles use 3.1-flash-lite-image: it restyles strongly (real chibi), keeps the
// exact subject count for team photos, and is the cheapest tier ($0.0336 per 1K image).
const TEAM_MODEL = 'gemini-3.1-flash-lite-image';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite-image';

// --- Cost logging -----------------------------------------------------------
// Rough USD/VND rate and per-model prices so each request logs its real cost.
// Image models charge a flat price per generated image at 1K resolution; the
// text counter model charges per token. Input is tiny (one ~768x1024 photo).
const USD_TO_VND = 26000;
const PRICING = {
  'gemini-2.5-flash-image':      { inPerM: 0.30, imageFlat: 0.039 },
  'gemini-3.1-flash-lite-image': { inPerM: 0.30, imageFlat: 0.0336 },
  'gemini-3.1-flash-image':      { inPerM: 0.30, imageFlat: 0.067 },
  'gemini-3.8-flash':            { inPerM: 0.30, outPerM: 2.50 }
};

function logGenCost(label, model, usage) {
  if (!usage) { console.log(`[cost] ${label} model=${model} (no usageMetadata)`); return; }
  const promptTok = usage.promptTokenCount || 0;
  const candTok = usage.candidatesTokenCount || 0;
  const totalTok = usage.totalTokenCount || 0;
  let imgTok = 0;
  for (const d of usage.candidatesTokensDetails || []) {
    if (d.modality === 'IMAGE') imgTok += d.tokenCount || 0;
  }
  const p = PRICING[model] || {};
  const inCost = (promptTok / 1e6) * (p.inPerM || 0);
  const outCost = p.imageFlat != null ? p.imageFlat : (candTok / 1e6) * (p.outPerM || 0);
  const usd = inCost + outCost;
  const vnd = Math.round(usd * USD_TO_VND);
  console.log(
    `[cost] ${label} model=${model} prompt=${promptTok} cand=${candTok} ` +
    `img=${imgTok} total=${totalTok} usd=$${usd.toFixed(4)} vnd=${vnd}`
  );
}

// Run one Gemini image generation and return the first inline image ({mimeType,data})
// or null. Output is forced to 1K resolution — the cheapest tier for these models.
async function runImageGen(parts, aspect, model) {
  const usedModel = model || DEFAULT_MODEL;
  const imageConfig = { imageSize: '1K' };
  if (aspect) imageConfig.aspectRatio = aspect;
  const response = await ai.models.generateContent({
    model: usedModel,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['Text', 'Image'], imageConfig }
  });
  logGenCost('generate', usedModel, response.usageMetadata);
  const rparts = response.candidates[0].content.parts;
  const imagePart = rparts.find((p) => p.inlineData);
  return imagePart ? imagePart.inlineData : null;
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter
// ---------------------------------------------------------------------------

const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodically clean up stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Concurrency limiter for Gemini calls
//
// A 2GB VPS cannot hold dozens of in-flight image requests at once: each one
// keeps the input + generated image in memory while awaiting Gemini (10-30s).
// We cap how many generate calls run concurrently and queue the rest. Requests
// beyond the queue cap are rejected (503) so total memory stays bounded.
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_GENERATE = parseInt(process.env.MAX_CONCURRENT_GENERATE || '5', 10);
const MAX_GENERATE_QUEUE = parseInt(process.env.MAX_GENERATE_QUEUE || '25', 10);

let activeGenerations = 0;
const generationQueue = [];

// Resolves true when a slot is free, false immediately when the queue is full.
function acquireGenerateSlot() {
  if (activeGenerations < MAX_CONCURRENT_GENERATE) {
    activeGenerations += 1;
    return Promise.resolve(true);
  }
  if (generationQueue.length >= MAX_GENERATE_QUEUE) {
    discord.notify(
      'generate-overload',
      '\u26d4 QU\u00c1 T\u1ea2I: h\u00e0ng ch\u1edd \u0111\u1ea7y (' + generationQueue.length + '/' + MAX_GENERATE_QUEUE +
        '), \u0111ang T\u1eea CH\u1ed0I request (HTTP 503). \u0110ang ch\u1ea1y ' + activeGenerations + '/' + MAX_CONCURRENT_GENERATE +
        '. H\u00e0nh \u0111\u1ed9ng: ki\u1ec3m tra RAM/CPU server, c\u00e2n nh\u1eafc t\u0103ng MAX_CONCURRENT_GENERATE ho\u1eb7c n\u00e2ng VPS.'
    );
    return Promise.resolve(false);
  }
  // A request now has to wait for a free slot → the server is under load.
  discord.notify(
    'generate-queue',
    '\u26a0\ufe0f \u0110ang d\u1ed3n t\u1ea3i: c\u00f3 request ph\u1ea3i x\u1ebfp h\u00e0ng ch\u1edd. \u0110ang ch\u1ea1y ' +
      activeGenerations + '/' + MAX_CONCURRENT_GENERATE + ', trong h\u00e0ng ' +
      (generationQueue.length + 1) + '/' + MAX_GENERATE_QUEUE + '.'
  );
  return new Promise((resolve) => generationQueue.push(() => resolve(true)));
}

function releaseGenerateSlot() {
  const next = generationQueue.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter; active count unchanged
  } else {
    activeGenerations -= 1;
  }
}

// ---------------------------------------------------------------------------
// Access control & daily token budget
// ---------------------------------------------------------------------------

function normaliseCode(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
}

function isValidCode(code) {
  if (!EVENT_CODE) return true; // feature disabled when no code configured
  return typeof code === 'string' && normaliseCode(code) === normaliseCode(EVENT_CODE);
}

let dailyUsage = { date: '', count: 0 };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Returns false when the daily cap is reached; otherwise increments and returns true.
function reserveDailyQuota() {
  const today = todayStr();
  if (dailyUsage.date !== today) {
    dailyUsage = { date: today, count: 0 };
  }
  if (DAILY_LIMIT > 0 && dailyUsage.count >= DAILY_LIMIT) {
    return false;
  }
  dailyUsage.count += 1;
  return true;
}

// Milestone alert thresholds for the (persisted) generated-image counter.
const GEN_ALERT_THRESHOLD = parseInt(process.env.GEN_ALERT_THRESHOLD || '400', 10);
const GEN_ALERT_STEP = parseInt(process.env.GEN_ALERT_STEP || '50', 10);

// Fires a Discord alert when the generated-image count reaches the threshold
// and every GEN_ALERT_STEP images after that. A unique key per milestone lets
// each one fire exactly once, bypassing the per-key cooldown throttle.
function checkGenMilestone(generated, requests) {
  if (generated < GEN_ALERT_THRESHOLD) return;
  if ((generated - GEN_ALERT_THRESHOLD) % GEN_ALERT_STEP !== 0) return;
  discord.notify(
    'gen-milestone-' + generated,
    '\ud83d\udcca M\u1ed0C T\u1ea0O \u1ea2NH: \u0111\u00e3 t\u1ea1o th\u00e0nh c\u00f4ng ' + generated +
      ' \u1ea3nh / ' + requests + ' l\u01b0\u1ee3t g\u1ecdi (t\u1ed5ng t\u00edch l\u0169y).'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDataUri(dataUri) {
  const match = dataUri.match(/^data:(image\/\w+);base64,(.+)$/s);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function estimateBase64Bytes(base64Str) {
  return Math.ceil((base64Str.length * 3) / 4);
}

// Keep the user-entered initial readable but safe: strip control chars, cap length.
function sanitizeInitial(initial) {
  if (typeof initial !== 'string') return '';
  return initial.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
}

function sanitiseStyleForClient(style) {
  return { id: style.id, label: style.label, preview: style.preview, prompt: style.prompt, promptVi: style.promptVi || style.prompt };
}

const MAX_PROMPT_LENGTH = 2000;

const FACE_GUARD =
  " Strictly preserve the person's exact facial features, identity, bone structure, " +
  'and natural skin tone from the provided photo — keep the same face, no distortion.';

function resolvePrompt(style, customPrompt) {
  const trimmed = (typeof customPrompt === 'string') ? customPrompt.trim() : '';
  // Manual style has no preset prompt: rely on the user's text and always append
  // a face-preservation clause so the generated image keeps the real face.
  if (!style.prompt) {
    if (!trimmed) return '';
    return (trimmed + FACE_GUARD).slice(0, MAX_PROMPT_LENGTH);
  }
  if (!trimmed) return style.prompt;
  return trimmed.slice(0, MAX_PROMPT_LENGTH);
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Block search engines & crawlers (keep the app private, avoid token abuse)
app.use((_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  next();
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// Browsers auto-request /favicon.ico; serve the SVG icon so it doesn't 404.
app.get('/favicon.ico', (_req, res) => {
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// Maintenance gate: when enabled, hide the site from everyone except admins
// (admins pass ?token=ADMIN_TOKEN or header x-admin-token). Blocks all routes.
function hasAdminToken(req) {
  if (!ADMIN_TOKEN) return false;
  const token = (req.query.token || req.get('x-admin-token') || '').trim();
  return token === ADMIN_TOKEN;
}

const MAINTENANCE_HTML =
  '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex, nofollow"><title>Đang bảo trì</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#001965;color:#fff;text-align:center;padding:24px}' +
  '.box{max-width:420px}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.6;opacity:.85;margin:0}' +
  '</style></head><body><div class="box"><h1>Hệ thống đang bảo trì</h1>' +
  '<p>Ứng dụng tạm thời tạm ngưng. Vui lòng quay lại sau. Cảm ơn bạn!</p></div></body></html>';

app.use((req, res, next) => {
  if (!MAINTENANCE_MODE || hasAdminToken(req)) return next();
  res.set('Retry-After', '3600');
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: 'Hệ thống đang bảo trì. Vui lòng quay lại sau.' });
  }
  return res.status(503).type('html').send(MAINTENANCE_HTML);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(storage.LOCAL_PUBLIC_PATH, express.static(storage.LOCAL_DIR));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/styles', (_req, res) => {
  res.json(STYLES.filter((s) => !s.hidden).map(sanitiseStyleForClient));
});

app.get('/api/config', (_req, res) => {
  res.json({ requireCode: Boolean(EVENT_CODE) });
});

app.post('/api/verify-code', (req, res) => {
  if (isValidCode(req.body && req.body.code)) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'M\u00e3 s\u1ef1 ki\u1ec7n kh\u00f4ng \u0111\u00fang.' });
});

app.post('/api/generate', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIp)) {
      return res.status(429).json({ error: 'Qu\u00e1 nhi\u1ec1u y\u00eau c\u1ea7u. Vui l\u00f2ng th\u1eed l\u1ea1i sau 1 ph\u00fat.' });
    }

    const { image, styleId, prompt: customPrompt, code, initial } = req.body;

    if (!isValidCode(code)) {
      return res.status(401).json({ error: 'M\u00e3 s\u1ef1 ki\u1ec7n kh\u00f4ng \u0111\u00fang ho\u1eb7c \u0111\u00e3 h\u1ebft hi\u1ec7u l\u1ef1c.' });
    }

    // Per-user cap: block before taking a concurrency slot / burning quota.
    // code + limit let the client show a localized (VI/EN) message; error is
    // the VI fallback for any client that ignores the code.
    if (userLimit.isAtLimit(initial, PER_USER_LIMIT)) {
      return res.status(429).json({
        code: 'USER_LIMIT',
        limit: PER_USER_LIMIT,
        error: 'B\u1ea1n \u0111\u00e3 d\u00f9ng h\u1ebft ' + PER_USER_LIMIT + ' l\u01b0\u1ee3t t\u1ea1o \u1ea3nh cho s\u1ef1 ki\u1ec7n n\u00e0y. C\u1ea3m \u01a1n b\u1ea1n \u0111\u00e3 tham gia!'
      });
    }

    if (!image) {
      return res.status(400).json({ error: 'Thi\u1ebfu \u1ea3nh \u0111\u1ea7u v\u00e0o.' });
    }
    if (!styleId) {
      return res.status(400).json({ error: 'Thi\u1ebfu ki\u1ec3u phong c\u00e1ch.' });
    }

    const style = STYLES.find((s) => s.id === styleId);
    if (!style) {
      return res.status(400).json({ error: 'Phong c\u00e1ch kh\u00f4ng h\u1ee3p l\u1ec7.' });
    }

    const finalPrompt = resolvePrompt(style, customPrompt);
    if (!finalPrompt) {
      return res.status(400).json({ error: 'Vui l\u00f2ng nh\u1eadp m\u00f4 t\u1ea3 phong c\u00e1ch.' });
    }

    const parsed = parseDataUri(image);
    if (!parsed) {
      return res.status(400).json({ error: '\u0110\u1ecbnh d\u1ea1ng \u1ea3nh kh\u00f4ng h\u1ee3p l\u1ec7.' });
    }

    if (estimateBase64Bytes(parsed.data) > MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: `\u1ea2nh v\u01b0\u1ee3t qu\u00e1 ${MAX_IMAGE_MB}MB.` });
    }

    // Protect VPS RAM: only a few Gemini calls run at once, the rest queue.
    const gotSlot = await acquireGenerateSlot();
    if (!gotSlot) {
      return res.status(503).json({ error: 'H\u1ec7 th\u1ed1ng \u0111ang qu\u00e1 t\u1ea3i. Vui l\u00f2ng th\u1eed l\u1ea1i sau gi\u00e2y l\u00e1t.' });
    }

    try {
      if (!reserveDailyQuota()) {
        return res.status(429).json({ error: '\u0110\u00e3 \u0111\u1ea1t gi\u1edbi h\u1ea1n t\u1ea1o \u1ea3nh trong ng\u00e0y. Vui l\u00f2ng quay l\u1ea1i sau.' });
      }

      stats.recordRequest();

      // Card styles: attach the swirl background reference so Gemini matches the
      // sample backdrop closely. The reference is a tiny (~5KB) image, so the
      // extra input token cost is negligible.
      const cardRef = CARD_STYLE_IDS.has(styleId) ? cardRefFor(styleId) : null;
      const useCardRef = !!cardRef;

      // Team styles: auto-detect the head count and ground the prompt on it so the
      // model keeps exactly that many people (prevents the 7->8 / 7->6 drift).
      let groundedPrompt = finalPrompt;
      let countClause = '';
      if (TEAM_STYLE_IDS.has(styleId)) {
        const n = await countPeopleInPhoto(parsed);
        if (n > 0) { countClause = peopleCountClause(n); groundedPrompt = finalPrompt + countClause; }
      }

      const aspect = CARD_ASPECT[styleId];
      const reqParts = [{ inlineData: { mimeType: parsed.mimeType, data: parsed.data } }];
      if (useCardRef) {
        reqParts.push({ inlineData: cardRef });
      }
      reqParts.push({ text: useCardRef ? groundedPrompt + CARD_BG_INSTRUCTION : groundedPrompt });
      const model = TEAM_STYLE_IDS.has(styleId) ? TEAM_MODEL : DEFAULT_MODEL;
      const imagePart = await runImageGen(reqParts, aspect, model);

      if (!imagePart) {
        discord.notify(
          'generate-error',
          '\u274c L\u1ed6I T\u1ea0O \u1ea2NH: Gemini kh\u00f4ng tr\u1ea3 v\u1ec1 \u1ea3nh (style: ' + styleId + '). HTTP 502.'
        );
        return res.status(502).json({ error: 'Kh\u00f4ng th\u1ec3 t\u1ea1o \u1ea3nh. Vui l\u00f2ng th\u1eed l\u1ea1i.' });
      }

      const resultBase64 = imagePart.data;
      const resultMime = imagePart.mimeType;

      const generated = stats.recordGenerated();
      checkGenMilestone(generated, stats.get().totalGenerateRequests);
      userLimit.increment(initial);

      return res.json({ image: `data:${resultMime};base64,${resultBase64}` });
    } finally {
      releaseGenerateSlot();
    }
  } catch (err) {
    console.error('[generate] Error:', err.message || err);
    discord.notify(
      'generate-error',
      '\u274c L\u1ed6I T\u1ea0O \u1ea2NH: ' + (err.message || String(err)) + '. HTTP 502.'
    );
    return res.status(502).json({ error: 'L\u1ed7i khi t\u1ea1o \u1ea3nh. Vui l\u00f2ng th\u1eed l\u1ea1i sau.' });
  }
});

app.get('/api/gallery', async (req, res) => {
  if (!ADMIN_TOKEN || (req.query.token || '').trim() !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 40) : '';
    const sort = req.query.sort === 'old' ? 'old' : 'new';
    const items = await storage.listGallery({ baseUrl: getBaseUrl(req), q, sort });
    return res.json({ count: items.length, items });
  } catch (err) {
    console.error('[gallery] Error:', err.message || err);
    return res.status(502).json({ error: 'Kh\u00f4ng th\u1ec3 t\u1ea3i danh s\u00e1ch \u1ea3nh.' });
  }
});

// Admin monitor: per-INITIAL image counts, totals and limit status.
app.get('/api/monitor', (req, res) => {
  if (!ADMIN_TOKEN || (req.query.token || '').trim() !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  const counts = userLimit.getAll();
  const users = Object.keys(counts)
    .map((initial) => ({
      initial,
      count: counts[initial],
      atLimit: PER_USER_LIMIT > 0 && counts[initial] >= PER_USER_LIMIT
    }))
    .sort((a, b) => b.count - a.count);
  const totalImages = users.reduce((sum, u) => sum + u.count, 0);
  const dailyCount = dailyUsage.date === todayStr() ? dailyUsage.count : 0;
  return res.json({
    users,
    totalImages,
    uniqueUsers: users.length,
    perUserLimit: PER_USER_LIMIT,
    dailyLimit: DAILY_LIMIT,
    dailyCount,
    stats: stats.get()
  });
});

app.post('/api/store', async (req, res) => {
  try {
    const { image, initial, styleId } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Thi\u1ebfu \u1ea3nh \u0111\u1ec3 l\u01b0u.' });
    }

    const parsed = parseDataUri(image);
    if (!parsed) {
      return res.status(400).json({ error: '\u0110\u1ecbnh d\u1ea1ng \u1ea3nh kh\u00f4ng h\u1ee3p l\u1ec7.' });
    }

    // Temporary instrumentation: time each step to find the 40-60s bottleneck.
    const t0 = Date.now();
    const kb = Math.round(Buffer.byteLength(parsed.data, 'base64') / 1024);
    const saved = await storage.saveImage(parsed.data, parsed.mimeType, getBaseUrl(req));
    const tUpload = Date.now();

    // Record the initial + metadata in the index so the gallery can search /
    // filter by it. Index failure must not break the user's download/QR flow.
    try {
      await storage.appendIndexEntry({
        id: saved.id,
        initial: sanitizeInitial(initial),
        url: saved.url,
        styleId: typeof styleId === 'string' ? styleId.slice(0, 64) : null,
        size: saved.size,
        createdAt: new Date().toISOString()
      });
    } catch (idxErr) {
      console.error('[store] Index write failed:', idxErr.message || idxErr);
    }
    const tIndex = Date.now();

    const qr = await QRCode.toDataURL(saved.url, { margin: 1, width: 240 });
    const tQr = Date.now();

    console.log(
      `[store] size=${kb}KB upload=${tUpload - t0}ms index=${tIndex - tUpload}ms ` +
      `qr=${tQr - tIndex}ms total=${tQr - t0}ms`
    );

    return res.json({ url: saved.url, id: saved.id, qr });
  } catch (err) {
    console.error('[store] Error:', err.message || err);
    return res.status(502).json({ error: 'Kh\u00f4ng th\u1ec3 l\u01b0u \u1ea3nh. Vui l\u00f2ng th\u1eed l\u1ea1i.' });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Photo Booth AI server running on http://localhost:${PORT}`);
});
