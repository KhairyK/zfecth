# Selamat Datang Di ZFecth

> ZFetch adalah sebuah library JavaScript modern yang dirancang untuk membuat proses pengambilan data melalui HTTP menjadi jauh lebih mudah, cepat, dan fleksibel. 
    Dibangun di atas fetch() bawaan browser, ZFetch memberikan berbagai fitur tambahan yang biasanya tidak disediakan secara default, sehingga developer
    dapat memiliki kontrol penuh terhadap setiap request yang berjalan

---

Contoh Pemakaian ZFecth: 

1. Inisialisasi Client (Simple)
```js
const api = zjs({
  baseURL: "https://jsonplaceholder.typicode.com",
  timeout: 5000
});
```

---

2. Get Data (GET)
```js
api.get("/posts")
  .then(res => {
    if (res.ok) {
      console.log("Data:", res.data);
    } else {
      console.error("Error:", res.error);
    }
  });
```

---

3. GET Dengan Cache TTL (dalam detik)
```js
api.get("/posts", {
  cache: 10 // cache 10 detik
}).then(r => console.log(r.data));
```

---

4. POST JSON
```js
api.post("/posts", {
  title: "ZFecth rocks!",
  body: "Halo dunia",
  userId: 1
})
.then(res => {
  console.log("Created:", res.data);
});
```

---

5. PUT / PATCH
```js
api.put("/posts/1", { title: "Updated!" });
api.patch("/posts/1", { title: "Partial Update!" });
```

---

6. DELETE
```js
api.delete("/posts/1")
  .then(r => console.log("Deleted:", r.status));
```

---

7. Retry & Backoff Otomatis
```js
api.get("/unstable-endpoint", {
  retry: 3,         // coba 3x
  retryDelay: 400   // base delay 400ms
});
```

---

8. Timeout
```js
api.get("/slow-api", {
  timeout: 2000 // 2 detik
});
```

---

9. Cancel Request
```
const token = api.CancelToken();

api.get("/posts", { signal: token.signal })
  .catch(err => console.log("Canceled:", err));

token.cancel(); // batalkan
```

---

10. Cancel Group (Batch Abort)
```
const group = api.cancelGroup();

api.get("/a", { group });
api.get("/b", { group });
api.get("/c", { group });

group.cancel("Stop semua!");
```

---

11. Interceptor Request
```
api.use({
  request(cfg) {
    console.log("Request ke:", cfg.url);
    return cfg;
  }
});
```

---

12. Interceptor Response
```js
api.use({
  response(res) {
    console.log("Status:", res.status);
    return res;
  }
});
```

---

13. Transform Request
```js
api.addTransformRequest((data, headers) => {
  console.log("Transform Body:", data);
  return data;
});
```

---

14. Transform Response
```js
api.addTransformResponse((data, res) => {
  if (Array.isArray(data)) {
    return data.slice(0, 5); // auto potong jadi 5 data
  }
  return data;
});
```

---

15. Global Error Handler
```js
api.onError((err, cfg) => {
  console.error("Global Error:", err.message);
});
```

---

16. Paralel Request (Promise.all)
```js
api.all([
  api.get("/posts/1"),
  api.get("/posts/2"),
  api.get("/posts/3"),
])
.then(([a, b, c]) => {
  console.log(a.data, b.data, c.data);
});
```

---

17. Auto Token (Authorization)
```js
api.setToken("TOKEN-RAHASIA");

// hasil:
// Authorization: Bearer TOKEN-RAHASIA
```

---

18. Manual Raw Request
```js
api.request({
  url: "/posts",
  method: "POST",
  data: { hello: "world" }
});
```

---

19. Env Chain (Dev → Prod → Staging)
```js
const base = zjs.env()
  .dev("http://localhost:3000")
  .prod("https://api.example.com")
  .staging("https://staging.example.com");

const apiEnv = zjs({ baseURL: base });

apiEnv.get("/info").then(r => console.log(r.data));
```, 
