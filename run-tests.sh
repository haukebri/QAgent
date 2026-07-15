#!/usr/bin/env bash
# Run the three benchmark tests N times each (default 5), one of each in parallel.
# Usage: ./run-tests.sh [runs]
set -u

RUNS="${1:-5}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

VORWERK_URL='https://www.vorwerk.com/de/de'
VORWERK_GOAL='Goal: I can reach the Vorwerk cart from the homepage with one featured Kobold product in it.
Steps:
- Dismiss the cookie dialog if it blocks the page
- Open "Online-Shop" in the main navigation and choose "Online Shop"
- On the "Vorwerk Online-Shop" page open "Kobold VR7 Saugroboter & RB7 Servicestation" from the product carousel
- On the product page click the main "In den Warenkorb" button for that product
- In the confirmation dialog click "Zur Kasse"
- The final page is the cart (URL ends with /shop/cart) and shows exactly one product with quantity 1
- Stop on the cart page; do not begin checkout'

AIDA_URL='https://aida.de/'
AIDA_GOAL='Goal: I can reach the AIDA tariff selection in the booking flow from the homepage.
Steps:
- Dismiss the cookie dialog if it blocks the page
- Open "Buchen" in the main navigation and choose "Kurzreisen"
- Confirm the page heading "Kurzreisen ab Deutschland" is visible
- Open "Details & Buchen" for the first displayed cruise
- On the cruise detail page confirm at least one cabin category is available with an "Auswählen" link, wait 2 seconds, then click that available link
- Continue in the newly opened booking page or tab
- The final page shows the selected cabin category, "Wählen Sie einen Tarif", and at least one available tariff selection such as "PREMIUM auswählen"
- Stop at tariff selection; do not select a tariff or enter traveler data'

REPLY_URL='https://www.reply.com/'
REPLY_GOAL='Goal: I can find current German technology jobs for professionals from the Reply homepage.
Steps:
- Dismiss the cookie dialog if it blocks the page
- Click "Join us" in the main navigation
- On the country chooser select "Germany"
- On the German careers page choose "Reply für Professionals"
- Click "Suche hier nach den ausgeschriebenen Tech Jobs."
- The final job-search page shows the filters "Germany", "Professional", and "Technology" and a non-empty list of job postings under "STELLENANZEIGE" and "STADT"'

run_one() {
  local name="$1" i="$2" url goal locale
  case "$name" in
    vorwerk-cart) url="$VORWERK_URL"; goal="$VORWERK_GOAL"; locale="de-DE" ;;
    aida-booking) url="$AIDA_URL"; goal="$AIDA_GOAL"; locale="de-DE" ;;
    reply-jobs) url="$REPLY_URL"; goal="$REPLY_GOAL"; locale="de-DE" ;;
  esac

  echo "--- $name run $i/$RUNS ---"
  node "$SCRIPT_DIR/src/cli.js" --url "$url" --locale "$locale" \
    --reporter list,trace --output-dir "$SCRIPT_DIR/results" "$goal" || true
}

for i in $(seq 1 "$RUNS"); do
  run_one vorwerk-cart "$i" &
  run_one aida-booking "$i" &
  run_one reply-jobs "$i" &
  wait
done
