#!/usr/bin/env bash
# Run the three benchmark tests N times each (default 5), one of each in parallel.
# Usage: ./run-tests.sh [runs]
set -u

RUNS="${1:-5}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

VORWERK_URL='https://www.vorwerk.com/de/de/c/home/angebote/summer-week'
VORWERK_GOAL='Goal: I can explore the summer-week offer and add a discounted product to the cart.
Steps:
- On the summer-week page I can see and click a "Kobold Angebote entdecken!" button which redirects to the summer-week/kobold url
- On this page the "Deine Akku-Alltagshelfer" teaser section shows at least two product offers, including "Kobold VM7 Akku-Handstaubsauger" and "Kobold VG100+ Flächenreiniger"
- I can click "Zu allen Angeboten" (the one in the "Deine Akku-Alltagshelfer" section) and it redirects to summer-week/summer-week-kobold
- On the summer-week-kobold page I can click the "Weitere ... Produkte anzeigen" button (the number in the label varies) and additional products appear in the list, including the Kobold PB440 Elektro-Polsterbürste
- I can click the teaser for "Kobold PB440 Elektro-Polsterbürste" which redirects to https://www.vorwerk.com/de/de/s/shop/kobold-pb440-elektro-polsterbuerste-de
- I can click "In den Warenkorb", after which a dialog appears offering "Weiter einkaufen" and "Zur Kasse"
- In that dialog I can click "Zur Kasse" which shows the cart page (url ends with /shop/cart) containing the Kobold PB440'

FORM_URL='https://www.gravityforms.com/form-templates/project-inquiry-form/'
FORM_GOAL='Goal: I successfully submit the project inquiry form and see the confirmation.
Steps:
1. Open the page and accept the cookie dialog if one appears
2. Fill in all fields marked (Required), including: Name, Email "admin@haukebrinkmann.de", and in the "Services Needed" checkbox group check the first option "Strategy & Consultation"
3. Click the "Submit Inquiry" button
4. If the page shows "There was a problem with your submission", read which fields the errors name, fix exactly those fields, and submit again - repeat until no errors remain
5. Finally a confirmation message like "Thank you for your project inquiry!" is shown'

AIDA_URL='https://aida.de/buchen/CO10260728/PREMIUM/meine-reise/reisende?adults=2&juveniles=0&children=0&babies=0&cabin=M'
AIDA_GOAL='Goal: As a user in the AIDA booking process (premium cruise, 2 adults) I select a cabin tariff, fill in the traveler data, and reach the insurance step where insurance options with prices are shown.
Steps:
- The booking page opens on the tariff selection in the cabin section; dismiss any cookie/consent dialog that appears
- Select a tariff for the cabin via its "Auswählen" button. Note: this may open a price panel that blocks other elements - close or complete it before interacting with anything behind it
- If a travel-option choice is offered, pick the individual option (labelled "Individuell" or similar)
- Fill all required traveler fields for both adults with plausible random data (names, birth dates, contact details)
- Continue to the next step. If a panel or overlay blocks a click, close or complete it first instead of retrying the same click
- Continue until the insurance step is shown, where insurance options and their prices are visible'

run_one() {
  local name="$1" i="$2" url goal locale
  case "$name" in
    vorwerk-summer-week) url="$VORWERK_URL"; goal="$VORWERK_GOAL"; locale="de-DE" ;;
    gravityforms-inquiry) url="$FORM_URL"; goal="$FORM_GOAL"; locale="en-US" ;;
    aida-booking) url="$AIDA_URL"; goal="$AIDA_GOAL"; locale="de-DE" ;;
  esac

  echo "--- $name run $i/$RUNS ---"
  node "$SCRIPT_DIR/src/cli.js" --url "$url" --locale "$locale" \
    --reporter list,trace --output-dir "$SCRIPT_DIR/results" "$goal" || true
}

for i in $(seq 1 "$RUNS"); do
  run_one vorwerk-summer-week "$i" &
  run_one gravityforms-inquiry "$i" &
  run_one aida-booking "$i" &
  wait
done
