from flask import Flask, send_from_directory
from routes import api
import os

app = Flask(__name__, static_folder="static", static_url_path="")
app.register_blueprint(api)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "").strip().lower() in {"1", "true", "yes"}
    threaded = os.getenv("FLASK_THREADED", "1").strip().lower() not in {"0", "false", "no"}
    app.run(debug=debug, host=host, port=port, threaded=threaded)
