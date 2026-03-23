# Patriot Elite Logistics — Booking System

Your booking website and Square payment backend, all in one.

---

## How to deploy (4 steps)

### Step 1: Get your Square credentials

Go to **https://developer.squareup.com/apps** and sign in with your Square account.

You need three values (you can start with Sandbox for testing):

| What | Where to find it |
|---|---|
| **Application ID** | On your app's main page — starts with `sandbox-sq0idb-` (sandbox) or `sq0idp-` (production) |
| **Access Token** | Under "Credentials" tab — starts with `EAAAl` |
| **Location ID** | Under "Locations" tab — starts with `L` |

Keep these handy — you'll paste them in during Step 3.

### Step 2: Push this project to GitHub

1. Go to **https://github.com/new** and create a new repository (name it anything, like `patriot-booking`)
2. Upload all the files from this folder to that repository

Or if you're comfortable with the terminal:
```
cd patriot-elite-booking
git init
git add .
git commit -m "Initial booking system"
git remote add origin https://github.com/YOUR_USERNAME/patriot-booking.git
git push -u origin main
```

### Step 3: Deploy to Railway (free trial, then ~$5/month)

1. Go to **https://railway.app** and sign in with your GitHub account
2. Click **"New Project"** → **"Deploy from GitHub Repo"**
3. Select the repository you just created
4. Railway will detect it's a Node.js app and start building automatically
5. While it builds, click **"Variables"** and add these four:

| Variable | Value |
|---|---|
| `SQUARE_ACCESS_TOKEN` | *(paste your access token)* |
| `SQUARE_APPLICATION_ID` | *(paste your application ID)* |
| `SQUARE_LOCATION_ID` | *(paste your location ID)* |
| `SQUARE_ENVIRONMENT` | `sandbox` *(change to `production` when ready to go live)* |

6. Railway will give you a URL like `patriot-booking-production-xxxx.up.railway.app` — that's your live site!

### Step 4: Update one line in the frontend

Open `public/index.html`, find this line near the top of the script:

```javascript
const SQUARE_APP_ID = 'YOUR_APP_ID';
```

Replace `YOUR_APP_ID` with your actual Application ID (the same one from Step 1). Push the change to GitHub and Railway will auto-redeploy.

That's it — your booking system is live.

---

## Going from sandbox to production

When you're done testing and ready to accept real payments:

1. In your Square Developer Dashboard, switch to the **Production** tab and grab your production credentials
2. In Railway, update the four environment variables with the production values, and change `SQUARE_ENVIRONMENT` to `production`
3. In `public/index.html`, swap the Square SDK script tag:
   - Change `sandbox.web.squarecdn.com` to `web.squarecdn.com`
   - Update `SQUARE_APP_ID` to your production Application ID
4. Push to GitHub — Railway auto-deploys

## Custom domain (optional)

Want it at `book.patriotelitelogistics.com` instead of the Railway URL?

1. In Railway, go to **Settings** → **Networking** → **Custom Domain**
2. Add `book.patriotelitelogistics.com`
3. Railway will give you a CNAME record — add it in your domain registrar's DNS settings

---

## Test card numbers (sandbox only)

| Card | Number |
|---|---|
| Visa (success) | `4532 0123 4567 0010` |
| Mastercard (success) | `5413 0000 0000 0000` |
| Decline | `4000 0000 0000 0002` |

Use any future expiry date, any 3-digit CVV, and any 5-digit ZIP.
