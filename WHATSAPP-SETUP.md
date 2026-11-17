# Setting up automatic WhatsApp reminders

TFNN already sends the reminders. It stays switched off until you finish these steps, and the app keeps working exactly the same in the meantime. The "WhatsApp" buttons in the Plan tab need no setup, because they open the farmer's own WhatsApp.

## What you need
- A phone number for TFNN that is **not** already used on WhatsApp or WhatsApp Business (a new SIM is fine). It receives a verification code by SMS or call.
- A Facebook account, to create a Meta Business account.
- A little money for messages. Meta charges per conversation, with a monthly free allowance. Check the current prices in Meta's WhatsApp Business Platform pricing page before you go live.

## Steps
1. Go to **developers.facebook.com**, log in, and create an app of type **Business**.
2. Add the **WhatsApp** product to the app. Meta creates a test business account and a test phone number so you can try it first.
3. Under **WhatsApp > API Setup**, add your real TFNN number and verify it. Copy the **Phone number ID** (a long number). This is `WHATSAPP_PHONE_NUMBER_ID`.
4. Make a permanent token: in **Business settings > Users > System users**, add a system user, give it access to your WhatsApp account, and generate a token with the `whatsapp_business_messaging` permission. This is `WHATSAPP_TOKEN`. Keep it secret.
5. Create the message template under **WhatsApp > Message templates**:
   - Name: `tfnn_task_digest`
   - Category: **Utility**
   - Language: English
   - Body: `Hi {{1}}, you have {{2}} farm task(s) due on TFNN: {{3}}. Open the app to mark them done.`
   Meta checks it, which usually takes minutes to a day. The status must say **Approved**.
6. In Render, open the TFNN-1 service > **Environment** and add `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`. Leave `WHATSAPP_TEMPLATE` and `WHATSAPP_TEMPLATE_LANG` alone unless you used a different name or language. Save, and Render redeploys.
7. Check the daily job is set up: GitHub > Actions > **Daily task reminders** needs the `CRON_SECRET` secret, as it does for email.
8. Test: in the app, open **Settings**, tick **WhatsApp me my task reminders**, and save. Add a task due today, then run the **Daily task reminders** workflow by hand (Actions > Run workflow). The reply shows a `whatsapp` section with `sent: 1`.

## If nothing arrives
- The workflow reply shows `"whatsapp": {"configured": false}`: the two Render variables are missing.
- `failed` is more than 0: the reason is saved in the `whatsapp_log` table (`error` column). The usual causes are a template that is not approved yet, a wrong template name, or an expired token.
- Meta only lets a business message someone first with an approved template, so TFNN always uses the template above. Free-text messages are not used.
- A farmer must have their real WhatsApp number as the phone number on their TFNN account. Numbers starting with 0 are converted to +264 automatically.
