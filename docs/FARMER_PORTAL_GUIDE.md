# How to change the TFNN farmer portal yourself

This guide is written for the TFNN repository on your Windows laptop. The portal is deliberately built with plain HTML, CSS and JavaScript so you can learn it without first learning a large frontend framework.

## 1. Protect the working version

Open Command Prompt and enter:

```cmd
cd /d "C:\Users\Grace\Documents\Coding\TFNN"
git checkout main
git pull origin main
git checkout -b my-portal-change
```

A branch is a safe copy of the code. If your experiment fails, `main` remains unchanged.

## 2. Know which file to open

| What you want to change | File |
|---|---|
| Colours, spacing, buttons and mobile layout | `public/styles.css` |
| Page wording and screen structure | `public/index.html` |
| Filters, forms, exports and button behaviour | `public/app.js` |
| Animal API and server-side validation | `src/routes/animals.js` |
| Database fields | a new numbered file in `sql/` |
| Which pages the server publishes | `src/index.js` |

Start with one small visual change in `public/styles.css`. For example, the main TFNN green is controlled by:

```css
:root {
  --forest: #143f2c;
}
```

Change the colour, save the file and refresh the browser. You can undo the unsaved Git change with:

```cmd
git restore public/styles.css
```

## 3. Run TFNN on your laptop

Install the packages once:

```cmd
npm install
```

Create a `.env` file from `env.example` and use a test database. Never put passwords or secret keys in GitHub.

Apply database changes only to that test database:

```cmd
npm run migrate
```

Start the app:

```cmd
npm run dev
```

Then open:

```text
http://localhost:4000
```

Sign in with a farmer account from your test database.

## 4. How one livestock field travels through TFNN

Adding a field such as `health_status` involves four connected changes:

1. Add the form control in `public/index.html`.
2. Read and display it in `public/app.js`.
3. Accept and validate it in `src/routes/animals.js`.
4. Add the database column in a new SQL migration.

If you change only the form, the information will appear on screen but will not be saved. Following all four points is what makes the feature real.

## 5. Test before uploading

Run:

```cmd
npm test
node --check public\app.js
node --check src\index.js
node --check src\routes\animals.js
```

Also test these actions in the browser:

- Sign in as a farmer.
- Add and edit one animal.
- Filter cattle, sheep and goats.
- Confirm Bull, Ram and Buck appear as breeding males.
- Confirm Bull calf, Ram lamb, Buck kid, Ox and Wether do not.
- Choose a sire and dam and inspect the pedigree.
- Turn off the connection, save one test record and reconnect.
- Export the livestock register.
- Sign in as another farmer and confirm the first farmer's animals are not visible.

## 6. Review and upload your change

See exactly what changed:

```cmd
git status
git diff
```

When it looks correct:

```cmd
git add .
git commit -m "Describe my farmer portal change"
git push -u origin my-portal-change
```

Open GitHub and create a pull request from `my-portal-change` into `main`. Review the changed files and test result before merging.

For the current redesign, the deployment must run `npm run migrate` before starting the new version. This creates the extra animal-detail columns without deleting existing records. Test the migration against a non-production database first, then take a database backup before applying it to the live database.

## The safest learning habit

Make one change at a time, test it, and commit it with a clear message. Small commits make mistakes easy to understand and easy to reverse.
