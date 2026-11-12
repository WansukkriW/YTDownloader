# YTDownloader

โปรแกรมโหลดคลิปเป็น **MP4** หรือ **MP3** จาก YouTube, Facebook, TikTok และเว็บอื่นอีกหลายเว็บ ใช้กับ Windows

## วิธีติดตั้ง

1. **[⬇️ กดตรงนี้เพื่อดาวน์โหลด YTDownloader-Setup.exe](https://github.com/WansukkriW/YTDownloader/releases/latest/download/YTDownloader-Setup.exe)**
2. ดับเบิลคลิกไฟล์ที่โหลดมา
3. ถ้าขึ้นหน้าจอ **"Windows protected your PC"** ให้กด **More info** แล้วกด **Run anyway**
4. รอติดตั้งเสร็จ โปรแกรมจะเปิดขึ้นมาเอง และมีไอคอนบนเดสก์ท็อป

ติดตั้งแล้วใช้ได้เลย ไม่ต้องลงโปรแกรมอื่นเพิ่ม

## วิธีใช้

1. คัดลอกลิงก์คลิปที่ต้องการ แล้วเปิดโปรแกรม ลิงก์จะถูกวางลงในช่องให้เอง
2. เลือก **วิดีโอ (MP4)** หรือ **เพลง (MP3)** แล้วเลือกคุณภาพ
3. กด **ดาวน์โหลด** ไฟล์จะไปอยู่ที่โฟลเดอร์ `Downloads\YTDownloader`

## ติดตั้งไม่ได้?

- **Windows บล็อกและไม่มีปุ่ม Run anyway:** แปลว่าเครื่องเปิด Smart App Control ไว้ จึงติดตั้งโปรแกรมนี้ไม่ได้ ไม่แนะนำให้ปิด เพราะปิดแล้วเปิดกลับไม่ได้
- **ระบบที่รองรับ:** ใช้ได้กับ Windows 10 และ 11 แบบ 64-bit เท่านั้น

## ถอนการติดตั้ง

ไปที่ **Settings → Apps → YTDownloader → Uninstall**

---

โปรดใช้กับคลิปที่คุณมีสิทธิ์ดาวน์โหลดเท่านั้น

โปรแกรมนี้ใช้ [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), [FFmpeg](https://ffmpeg.org) (GPL v3) และฟอนต์ IBM Plex Sans Thai Looped (OFL) รายละเอียดอยู่ในโฟลเดอร์ [vendor/licenses](vendor/licenses)

<details>
<summary>สำหรับนักพัฒนา</summary>

```
npm install
npm start          # รันแบบทดสอบ (ใช้ yt-dlp และ ffmpeg จาก PATH)
```

สร้าง Setup.exe:

1. ใส่ `yt-dlp.exe`, `ffmpeg.exe` และ `ffprobe.exe` ไว้ในโฟลเดอร์ `vendor/`
2. รัน `npm run dist` แล้วไฟล์จะอยู่ที่ `dist/YTDownloader-Setup.exe`

</details>
