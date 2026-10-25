# Quick Start Guide for Teammates

## 1. Prerequisites
- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- Access to the MongoDB Atlas cluster (`engramdemo.betk40.mongodb.net`)

---

## 2. Setting Up & Running the Application

### Step 1: Install Backend Dependencies & Start Server
```bash
cd backend
npm install
npm run dev
```
* The backend will start on **`http://localhost:5000`**.
* Connects automatically to the **`engram`** database on MongoDB Atlas.

### Step 2: Install Frontend Dependencies & Start UI
In a separate terminal:
```bash
cd frontend
npm install
npm run dev
```
* The React companion UI will start on **`http://localhost:5173`**.

---

## 3. How to Test the Full Experience

1. Open `http://localhost:5173/` in your browser.
2. **Text Input:** Type `"I had lunch with Sarah today"` $\rightarrow$ Engram acknowledges and saves the memory.
3. **Voice Input:** Click `🎙️ Start Voice Listening (Audio Only)` $\rightarrow$ speak into your mic $\rightarrow$ click `Process What I Spoke`.
4. **Live Camera Stream:** Click `🎥 Start Video & Audio` $\rightarrow$ shows camera stream, captures visual context, and listens to voice simultaneously.
5. **Caregiver Portal:** Click `Caregiver Portal` at the top right to see all live alerts and the memory timeline pulled directly from MongoDB Atlas!

---

## 4. AnchorCare Integration Test
To run the automated acceptance test suite for the AnchorCare integration:
```bash
cd adapter
node demo-acceptance.js
```
All 6 acceptance lifecycle stages (Draft ingestion, recall exclusion, caregiver approval, recall inclusion, withdrawal, and idempotency) will execute and report status.
