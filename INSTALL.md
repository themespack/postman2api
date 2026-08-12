# Instalasi — postman2api di Cloudflare Workers

## 1. Prasyarat

- **Bun** — `curl -fsSL https://bun.sh/install | bash`
- **Akun Cloudflare** (gratis) — https://dash.cloudflare.com/sign-up
- **Python 3** (opsional, hanya diperlukan kalau kamu mau login akun Postman via browser secara lokal)

## 2. Clone & install dependencies

```bash
git clone https://github.com/themespack/postman2api.git
cd postman2api
git checkout claude/kode-wrangler-cloudflare-os8cq3   # branch hasil port ke Wrangler

bun install
```

## 3. Deploy — satu perintah

```bash
bun run deploy
```

Perintah ini (`scripts/setup.ts`) menjalankan semua langkah instalasi secara otomatis dan **aman dijalankan berulang kali** (idempotent):

1. **Cek login Cloudflare** — kalau belum login, otomatis membuka `wrangler login` (buka browser untuk autentikasi)
2. **Buat D1 database** — kalau belum ada, otomatis dibuat dan id-nya ditulis otomatis ke `wrangler.json`
3. **Jalankan migrasi skema database** ke D1 (remote)
4. **Generate & upload secrets** — `API_KEY` dan `ENCRYPTION_KEY` dibuat otomatis secara acak kalau belum di-set, lalu diupload sebagai Cloudflare secret
5. **Build dashboard** (React + Vite)
6. **Deploy Worker** ke Cloudflare

Di akhir proses, `API_KEY` dan `ENCRYPTION_KEY` yang di-generate akan ditampilkan sekali di terminal — **simpan baik-baik**, karena tidak bisa dilihat lagi setelahnya. `API_KEY` inilah yang kamu pakai untuk memanggil endpoint `/v1/*`.

Setelah selesai, Wrangler akan menampilkan URL Worker kamu, contoh:
`https://postman2api.<subdomain-kamu>.workers.dev`

<details>
<summary>Instalasi manual step-by-step (kalau tidak mau pakai script otomatis)</summary>

```bash
cd dashboard && bun install && bun run build && cd ..

# Buat database D1, id-nya otomatis tersimpan lewat --update-config
bunx wrangler d1 create postman2api --binding DB --update-config

# Terapkan skema
bunx wrangler d1 migrations apply DB --remote

# Set secrets (jangan pernah commit nilai asli ke git)
bunx wrangler secret put API_KEY
bunx wrangler secret put ENCRYPTION_KEY

bunx wrangler deploy
```
</details>

## 4. Tambah akun Postman

Login browser otomatis (Camoufox) **tidak bisa jalan di Cloudflare Workers** (tidak ada subprocess/Python di runtime Workers), jadi generate token-nya secara lokal dulu:

```bash
python3 -m venv scripts/auth/.venv
source scripts/auth/.venv/bin/activate
pip install -r scripts/auth/requirements.txt

bun src/cli.ts login you@gmail.com passwordkamu
```

CLI ini menulis token (`postman_sid`, `user_id`, `workspace_id`, `workspace_subdomain`) langsung ke D1 lokal. Untuk memasukkannya ke Worker yang sudah dideploy:

- **Dashboard** → buka `https://<worker-kamu>.workers.dev` → tab Accounts → "Manual Token", atau
- **API langsung**:

```bash
curl https://<worker-kamu>.workers.dev/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"email":"you@gmail.com","tokens":{"postman_sid":"...","user_id":"...","workspace_id":"...","workspace_subdomain":"..."}}'
```

## 5. Tes API

```bash
curl https://<worker-kamu>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer API_KEY_KAMU" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Hello!"}]}'
```

## 6. Development lokal (opsional)

```bash
cp .dev.vars.example .dev.vars   # isi API_KEY & ENCRYPTION_KEY untuk lokal
bunx wrangler d1 migrations apply DB --local
bun run build                     # build dashboard sekali
bun run dev                       # wrangler dev, http://localhost:8787
```

## Troubleshooting

- **`wrangler login` tidak membuka browser otomatis** — script akan menampilkan URL, buka manual di browser mana pun.
- **"A database with that name already exists"** — normal kalau kamu re-run `bun run deploy`; script otomatis mendeteksi database yang sudah ada dan memakainya lagi (tidak membuat duplikat).
- **Ganti `API_KEY`/`ENCRYPTION_KEY`** — jalankan `bunx wrangler secret put API_KEY` (atau `ENCRYPTION_KEY`) lagi, nilainya akan ditimpa.
- **Reset database** — hapus semua isi tabel manual lewat `bunx wrangler d1 execute DB --remote --command "DELETE FROM accounts"` (dan tabel lain sesuai kebutuhan), atau `wrangler d1 delete postman2api` untuk hapus total lalu deploy ulang dari awal.
