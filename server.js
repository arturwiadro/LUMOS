import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

let receivedData = [];

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "LUMOS backend działa"
  });
});

app.post("/api/data", (req, res) => {
  const payload = req.body;

  console.log("Odebrane dane:", JSON.stringify(payload, null, 2));

  receivedData.push({
    received_at: new Date().toISOString(),
    ...payload
  });

  if (receivedData.length > 200) {
    receivedData.shift();
  }

  res.status(200).json({
    status: "ok",
    message: "Dane odebrane poprawnie"
  });
});

app.get("/api/data", (req, res) => {
  res.json(receivedData);
});

app.listen(port, () => {
  console.log(`Server działa na porcie ${port}`);
});
