# Live demo runbook (15 minutes)

The one line people should leave with:

> **One form. Four AI agents. Every referral answered. None lost, even when the AI fails.**

Say it on the promise slide, prove it with the AI outage, and say it again at the close.

The deck has the full word-for-word script in each slide's speaker notes. This page covers everything around it: setup, the click path, what to do when something breaks, and the rehearsal log.

## Pick your plan the day before

| | Plan A: the real workflow | Plan B: the demo server |
|---|---|---|
| What runs | Your n8n workflow, real Claude agents, real HubSpot, Slack and Gmail | `npm run demo`: the same responses, with agents simulated by keyword rules |
| Needs | A working n8n instance, all credentials connected, Wi-Fi | Only this laptop. Works offline. |
| The AI outage moment | Not practical live. Switch to Plan B for that one step. | Press `a` in the terminal |
| What you must say | Nothing extra | "This is my test bench. The agents here are simulated, so the demo can't fail on Wi-Fi. It answers exactly like the real workflow." |

A good mix, once Plan A works: send Maria through the real workflow, so the audience sees the real Slack post and the real email, then switch to the test bench for the AI outage.

## Setup

**The day before**

- [ ] Run `npm test`. All 41 tests should pass.
- [ ] Run `npm run rehearse`. It should end with "fits" and "yes".
- [ ] **Plan A only.** Make sure the instance is running, import `n8n/referral-partner-program.json`, connect every credential and activate the workflow. Then run the rehearsal against it:
  ```
  WEBHOOK=https://<your-instance>/webhook/referral npm run rehearse
  ```
  This sends real emails and Slack posts. If the "system" column shows more than about 12 seconds per referral, the demo will run long. In that case, send David and Emily through the test bench instead.
- [ ] **Plan A only.** Put a real address you can open on stage in place of each example.com address below, using plus addressing such as you+maria@yourdomain. The agent lowers the score when the email doesn't match the name. That's the story on the "What I learned" slide, but it will also turn Maria from Priority into Standard. Use it on purpose or not at all.

**Thirty minutes before**

- [ ] Plug in power. Turn on Do Not Disturb. Close Slack notifications, email and chat.
- [ ] Run `npm run demo` in a terminal and leave that terminal visible but small.
- [ ] Open two browser windows side by side. On the left: `http://localhost:8787`, zoomed to 125%. On the right: `http://localhost:8787/feed`, or the real Slack channel for Plan A.
- [ ] Press `c` in the demo terminal to clear the feed.
- [ ] Open this page on your phone, or print the persona card below.
- [ ] Open the deck in Present mode on the first slide.

## Persona card (copy and paste)

Partner code for every referral: `PARTNER001`. The form remembers it after the first one.

| Who | Email | Phone | "Something else" text | Expect |
|---|---|---|---|---|
| Maria Sanchez | maria.sanchez@example.com | +1 415 555 0192 | Ready to buy term life for my family this month | Priority |
| David Kim | david.kim@example.com | +1 415 555 0143 | Comparing auto insurance quotes, not urgent | Standard |
| Emily Carter | emily.carter@example.com | +1 415 555 0177 | Just browsing, curious what home insurance costs | Nurture |
| Jordan Lee *(AI outage)* | jordan.lee@example.com | +1 415 555 0110 | Need home insurance before closing next week | Standard, "review manually" |
| *(optional)* wrong code | Use `PARTNER01` with any client | | | Error next to the code field |

Choose "Something else" in the "What are they looking for?" menu, then paste the text. Tick the consent box every time.

## Run of show

| Clock | Slide | You do | The point |
|---|---|---|---|
| 0:00 | Cover | Introduce yourself | "I'll break it live" |
| 0:20 | Problem | Talk through the three cards | Silence, no ranking, retyping |
| 1:30 | Promise | Say the line slowly | One form, four agents |
| 2:00 | Demo plan | Leave it up for a few seconds | The map |
| 2:30 | *(browser)* | Send Maria. Show the badge, then the feed. | Priority, with a reason |
| 3:45 | *(browser)* | Send David, then Emily, quickly | Three answers |
| 5:15 | *(browser)* | **Optional:** a wrong code, only if you're at 5:15 or earlier | Errors next to the field |
| 5:15 | *(terminal)* | "I'm cutting the AI off." Press `a`. Send Jordan. | It still goes through |
| 6:30 | Break it | Recap the three outcomes. Press `a` again to restore the AI. | Never depended on the AI |
| 7:00 | Architecture | Point left to right | Five stages |
| 8:30 | Agents | Walk the right-hand column | Every agent has a plan B |
| 9:30 | One rule | The four steps | AI output is untrusted input |
| 10:45 | Testing | The Slack bug story | Found by running, not reading |
| 12:00 | Learned | Tell the Maria story properly | The AI caught my fake data |
| 14:15 | Close | Say the line, then stop | Every referral answered |

If you reach 7:00 and you're still in the browser, skip straight to the Architecture slide. Don't apologize. Just move on.

## When something goes wrong

| What happens | Do this |
|---|---|
| Wi-Fi drops (Plan A) | Say "Let me switch to my test bench," and continue on Plan B. |
| A referral spins for more than 20 seconds | Keep talking about what the agents are doing. At 45 seconds the form explains itself. Then show the "Same referral, two views" slide. |
| The tier isn't what you expected | That's a real AI judgment, so read the summary aloud: "It saw something different. Here's why." Never argue with the screen. |
| The demo server won't start | Show the "Same referral, two views" slide and narrate it. All the screenshots are real captures. |
| Port 8787 is busy | Run `PORT=8788 npm run demo`. |
| You forget to restore the AI after the outage | Press `a`. The pill on the feed page turns back to "up". |

## Backup recording (Loom, 15 minutes, under 200 MB)

Record it after your second spoken rehearsal, while the timing is fresh. It's the version people will rewatch, so do it as one take of the real talk, not a separate tutorial.

1. **Set up Loom** for screen and camera, at 720p. That's enough for slides and a form, and it keeps the file small.
2. **Use the same setup as on stage:** deck in Present mode, the two browser windows side by side, and the demo terminal visible.
3. **Record all 15 minutes in one take,** including the AI outage. Say the disclosure line if you're on the demo server.
4. **Check the length.** It should be between 14 and 16 minutes, and Loom shows it.
5. **Download the MP4 and check its size:**
   ```
   ls -lh ~/Downloads/*.mp4
   ```
   If it's over 200 MB, this re-encodes a 15-minute video to about 170 MB:
   ```
   ffmpeg -i in.mp4 -vf scale=-2:720 -c:v libx264 -b:v 1400k -maxrate 1400k -bufsize 2800k -c:a aac -b:a 96k out.mp4
   ```
6. **Give the link a clear title,** such as "Referral Partner Portal, Demo Day backup". Keep the link in the deck's last slide notes in case the live demo fails.

## Likely questions

- **"What does it cost per referral?"** Four short Claude calls. It works out to roughly a cent or two per referral at current API prices, but that's an estimate, so check the usage page in the Anthropic console. n8n, HubSpot and Slack cost whatever your plans already cost.
- **"What if the AI ranks someone wrong?"** It only sets the order of callbacks. It never drops a lead, and every lead still reaches sales with the reasoning attached. A salesperson can always overrule it.
- **"Where does the client's data go?"** To the Google Sheet, HubSpot, Slack, and to Anthropic's API for scoring. The partner confirms the client agreed to be contacted before sending.
- **"Why n8n and not code?"** Someone who doesn't write code can open the workflow, see every step and change a prompt. The tests guard the parts that broke before.
- **"Can I use it?"** Yes. The README lists every setup step, and the demo server lets anyone try it in two minutes without accounts.

## Rehearsal log

Two automated dry runs were done on October 20 against the demo server, at real speed in headless Chrome. Typing time is estimated at 25 seconds per referral with copy-paste. Speech is timed at 140 words per minute.

| | Dry run 1 | Dry run 2 |
|---|---|---|
| Live demo | 5:35, over the 5:00 slot | 4:49, fits |
| Every step behaved as expected | Yes | Yes |
| Problem section speech | 1.6 of 2 min | 1.6 of 2 min |
| Technical section speech | 3.7 of 5 min | 3.7 of 5 min |
| Learned section speech | 1.6 of 3 min, underfilled | 2.3 of 3 min |
| Changes made after the run | Made the wrong-code step optional. Added the "what I'd build next" beat. | None needed |

**Your two spoken rehearsals.** These are for you to do out loud, with a timer, in front of one other person if possible.

| | Rehearsal 1 | Rehearsal 2 |
|---|---|---|
| Date | | |
| Finished at (target 15:00) | | |
| Demo section length (target 5:00) | | |
| Where I stumbled | | |
| What I changed | | |
