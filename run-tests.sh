#!/usr/bin/env bash
# Run the three benchmark tests N times each (default 5).
# Usage: ./run-tests.sh [runs]
set -u

RUNS="${1:-5}"
QAGENT="node $(dirname "$0")/src/cli.js"

VORWERK_URL='https://www.vorwerk.com/de/de/c/home/angebote/summer-week'
VORWERK_GOAL='Goal: I can explore the summer-week offer and add a discounted product to the cart.
Steps:
- On the summer-week page I can see and click a "Kobold Angebote entdecken!" button which redirects to the summer-week/kobold url
- On this page the "Deine Akku-Alltagshelfer" teaser section shows two product offers: "Kobold VM7 Akku-Handstaubsauger" and "Kobold VG100+ Flächenreiniger"
- I can click "Zu allen Angeboten" in the "Deine Akku-Alltagshelfer" section which redirects to summer-week/summer-week-kobold
- On the summer-week-kobold page I can click "Weitere 6 Produkte anzeigen" and additional products appear in the list, including the Kobold PB440 Elektro-Polsterbürste
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
AIDA_GOAL='Goal: As a user in the AIDA booking process (premium cruise, 2 adults, cabin preselected) I fill in the traveler data and reach the insurance step where insurance options with prices are shown.
Steps:
- The booking page opens on the traveler data step; dismiss any cookie/consent dialog that appears
- Fill all required traveler fields for both adults with plausible random data (names, birth dates, contact details)
- If a travel-option choice is offered, pick the individual option (labelled "Individuell" or similar)
- Continue to the next step. If a panel or overlay blocks a click, close or complete it first instead of retrying the same click
- Continue until the insurance step is shown, where insurance options and their prices are visible'

run_batch() {
  local name="$1" url="$2" goal="$3" locale="$4"
  local pass=0 fail=0 other=0
  echo "=== $name ($RUNS runs) ==="
  for i in $(seq 1 "$RUNS"); do
    echo "--- $name run $i/$RUNS ---"
    $QAGENT --url "$url" --locale "$locale" --reporter list,json "$goal"
    case $? in
      0) pass=$((pass+1)) ;;
      1) fail=$((fail+1)) ;;
      *) other=$((other+1)) ;;
    esac
  done
  echo "=== $name summary: $pass pass, $fail fail, $other error ==="
  echo
}

run_batch "vorwerk-summer-week" "$VORWERK_URL" "$VORWERK_GOAL" "de-DE"
run_batch "gravityforms-inquiry" "$FORM_URL" "$FORM_GOAL" "en-US"
run_batch "aida-booking" "$AIDA_URL" "$AIDA_GOAL" "de-DE"
