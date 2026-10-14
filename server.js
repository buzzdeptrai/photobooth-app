require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { GoogleGenAI } = require('@google/genai');
const storage = require('./lib/storage');
const discord = require('./lib/discord');

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
    preview: '/img/s5.jpg',
    prompt:
      'A high-quality, professional 3D toy figure based on the person in this photo, strictly ' +
      'maintaining 100% identical facial features, original skin tone, eyes, and friendly ' +
      'expression, reimagined as an adorable chibi-style collectible art toy (blind box figure ' +
      "style, similar to Pop Mart). The character is an 'AI & DIGITAL WEEK' champion, wearing a " +
      'cute oversized deep navy blue hoodie with a tiny Novo logo and futuristic ' +
      'data/network motifs on the chest, paired with tiny stylish blue and white sneakers. The ' +
      "figure is standing on a mini glossy plastic pedestal with 'SPECIAL EDITION 20/10' written " +
      'on it, positioned inside or next to a transparent open-front toy packaging box (blind box ' +
      "style) decorated with vibrant 'NOVO DIGITAL WEEK' and 'HAPPY WOMEN'S DAY 20/10' " +
      'branding, logos, and playful digital glitches. Soft, colorful volumetric lighting illuminates ' +
      'the scene, highlighting shiny, smooth plastic/resin toy materials, vibrant pastel gradients, ' +
      'and playful holographic micro-details on the box packaging. In the background, there is a ' +
      'blurry, out-of-focus corporate office. Creative CGI/Clay 3D render, Octane render, pop-toy ' +
      'art aesthetic with rich depth of field.',
    promptVi:
      'Một mô hình đồ chơi 3D chuyên nghiệp chất lượng cao dựa trên người trong ảnh, giữ nguyên 100% ' +
      'đường nét khuôn mặt, tông da gốc, ánh mắt và biểu cảm thân thiện, được tái hiện thành nhân vật ' +
      'chibi đáng yêu sưu tầm (phong cách blind box, tương tự Pop Mart). Nhân vật là nhà vô địch "AI & ' +
      'DIGITAL WEEK", mặc áo hoodie xanh navy đậm quá khổ dễ thương với logo Novo nhỏ và họa tiết ' +
      'dữ liệu/mạng lưới tương lai trên ngực, đi giày sneaker xanh-trắng nhỏ xinh. Mô hình đứng trên bệ ' +
      "nhựa bóng mini ghi 'SPECIAL EDITION 20/10', đặt bên trong hoặc cạnh hộp đồ chơi trong suốt mở mặt " +
      "trước (kiểu blind box) trang trí rực rỡ bằng thương hiệu 'NOVO DIGITAL WEEK' và 'HAPPY " +
      "WOMEN'S DAY 20/10', logo và hiệu ứng glitch số vui nhộn. Ánh sáng thể tích mềm mại, nhiều màu sắc " +
      'chiếu rọi khung cảnh, làm nổi bật chất liệu nhựa/resin bóng mượt, dải màu pastel rực rỡ và các chi ' +
      'tiết ảnh ba chiều vui nhộn trên hộp. Hậu cảnh là một văn phòng doanh nghiệp mờ ngoài tiêu điểm. ' +
      'Kết xuất 3D CGI/Clay sáng tạo, Octane render, thẩm mỹ pop-toy với độ sâu trường ảnh phong phú.'
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

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
  res.json(STYLES.map(sanitiseStyleForClient));
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

    const { image, styleId, prompt: customPrompt, code } = req.body;

    if (!isValidCode(code)) {
      return res.status(401).json({ error: 'M\u00e3 s\u1ef1 ki\u1ec7n kh\u00f4ng \u0111\u00fang ho\u1eb7c \u0111\u00e3 h\u1ebft hi\u1ec7u l\u1ef1c.' });
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

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: parsed.mimeType, data: parsed.data } },
              { text: finalPrompt }
            ]
          }
        ],
        config: {
          responseModalities: ['Text', 'Image']
        }
      });

      const parts = response.candidates[0].content.parts;
      const imagePart = parts.find((p) => p.inlineData);

      if (!imagePart) {
        return res.status(502).json({ error: 'Kh\u00f4ng th\u1ec3 t\u1ea1o \u1ea3nh. Vui l\u00f2ng th\u1eed l\u1ea1i.' });
      }

      const resultBase64 = imagePart.inlineData.data;
      const resultMime = imagePart.inlineData.mimeType;

      return res.json({ image: `data:${resultMime};base64,${resultBase64}` });
    } finally {
      releaseGenerateSlot();
    }
  } catch (err) {
    console.error('[generate] Error:', err.message || err);
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

    const saved = await storage.saveImage(parsed.data, parsed.mimeType, getBaseUrl(req));

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

    const qr = await QRCode.toDataURL(saved.url, { margin: 1, width: 240 });

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
