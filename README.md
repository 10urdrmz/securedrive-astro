# SecureDrive VIP: Astro + EmDash

securedrive.org'un yeni sürümü. Herkese açık site Astro ile sunucu tarafında
oluşturulur, içerik EmDash CMS'ten gelir. Canlıda Cloudflare Workers üzerinde
D1 veritabanı ve R2 medya deposuyla çalışır.

## Yerelde çalıştırma

```bash
npm install
cp .env.example .env
npm run dev      # ilk açılışta şema kurulur
npm run seed     # başlangıç içeriği (hizmetler, filo, 77 rota, SSS, sayfalar)
```

- Site: http://localhost:4321 (`/en`, `/ar`, `/ru`)
- Yönetim paneli: http://localhost:4321/_emdash/admin

## Cloudflare'e yayınlama

```bash
npx wrangler login
npx wrangler d1 create securedrive          # çıkan database_id'yi wrangler.jsonc'a ekleyin
npx wrangler r2 bucket create securedrive-media
npx wrangler secret put EMDASH_ENCRYPTION_KEY
npx wrangler secret put INQUIRY_NOTIFY_EMAIL  # isteğe bağlı
npm run deploy
```

Ardından `/_emdash/admin` adresinden ilk yönetici hesabını oluşturun.

## Formlar

Transfer, iletişim ve kurumsal formları `plugins/inquiries` eklentisine gider.
Her talep panelde **Gelen Talepler** altında taslak olarak kaydedilir ve
`INQUIRY_NOTIFY_EMAIL` tanımlıysa e-posta ile bildirilir. Bu kayıtlar kişisel veri
içerir; yayınlamayın.

Geliştirici notları için `AGENTS.md` dosyasına bakın.
