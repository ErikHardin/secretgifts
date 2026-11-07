# 🎁 Secret Gifts

A family gift exchange app. People keep their own wishlists (links to Amazon, Target, anywhere). The admin sets up exchanges with a dollar limit. A Cloudflare Worker draws names, so nobody can see the matches. It skips spouses, direct family, and last year's pairs, then emails everyone their match.

Live at: https://ech-technicalsolutions.com/secretgifts/

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app (Firebase Auth + Realtime Database) |
| `database.rules.json` | Realtime Database security rules |
| `worker/worker.js` | Cloudflare Worker: draw, emails, anonymous questions |
| `worker/wrangler.toml` | Worker config, used if you deploy from GitHub |

## One-time setup

### 1. Firebase (new project)
1. In the Firebase console, create a project named **secretgifts**.
2. Under **Build → Authentication → Sign-in method**, enable **Email/Password**, then turn on **Email link (passwordless sign-in)**.
3. Under **Authentication → Settings → Authorized domains**, add `ech-technicalsolutions.com`.
4. Under **Build → Realtime Database**, create a database (choose a US location, start in locked mode).
5. On the Realtime Database **Rules** tab, paste in `database.rules.json` and click **Publish**.
6. Under **Project settings → General → Your apps**, add a **Web app**. Copy the config values into `CONFIG.firebase` at the top of the script in `index.html`.
7. Under **Project settings → Service accounts**, click **Generate new private key**. Keep the JSON file; the Worker needs it in step 3.

### 2. Resend (email)
1. Sign up at resend.com. The free tier allows 3,000 emails a month.
2. Under **Domains → Add domain**, enter `ech-technicalsolutions.com`.
3. Add the DNS records Resend shows (TXT/MX for SPF and DKIM) in GoDaddy DNS. Then click **Verify**.
4. Under **API Keys**, create a key with sending access.

### 3. Cloudflare Worker
1. Create a Worker named **secretgifts**. Either paste in `worker/worker.js`, or connect this repo with root directory `worker`.
2. Under **Settings → Variables and Secrets**, add these:

| Name | Type | Value |
|---|---|---|
| `DB_URL` | Text | `https://<project-id>-default-rtdb.firebaseio.com` |
| `ADMIN_EMAIL` | Text | `erikchardin@gmail.com` |
| `APP_URL` | Text | `https://ech-technicalsolutions.com/secretgifts/` |
| `FROM_EMAIL` | Text | `Secret Gifts <gifts@ech-technicalsolutions.com>` |
| `ALLOWED_ORIGIN` | Text | `https://ech-technicalsolutions.com` |
| `SERVICE_ACCOUNT_JSON` | Secret | the entire service-account JSON file contents |
| `RESEND_API_KEY` | Secret | the Resend API key |

3. Copy the Worker's URL into `CONFIG.workerUrl` in `index.html`.

### 4. GitHub Pages
Under the repo's **Settings → Pages**, deploy from branch `main`, folder `/ (root)`.

> The admin email is also hard-coded in `database.rules.json` and `CONFIG.adminEmail`. If you change admins, change all three places.

## Using it
1. Sign in with the admin email.
2. Go to **Admin → Add person**. Add yourself first, then everyone else. Set each person's spouse and direct family. Exclusions apply both ways.
3. Go to **New exchange**. Set the name, year, dollar limit, date, and who's in. One person can be in many exchanges.
4. Under **Last year's pairs**, enter who gave to whom last year so the draw won't repeat it. Pairs from future draws are saved automatically.
5. Click **Send invites** to email everyone a link to add their wishlist.
6. Click **Draw names**. Everyone gets an email with their match, and the app shows nobody's match but your own.

Givers can send their recipient anonymous questions in the app, and the recipient gets an email.

## Privacy note
The app and the database rules keep matches hidden from everyone, including the admin. As the Firebase project owner, you could still open `matches` in the Firebase console, so don't look there.
