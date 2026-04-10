import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "LUMOS backend działa"
  });
});

app.listen(port, () => {
  console.log(`Server działa na porcie ${port}`);
});
