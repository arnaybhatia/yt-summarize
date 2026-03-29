from flask import Flask, send_from_directory
from routes import api

app = Flask(__name__, static_folder="static", static_url_path="")
app.register_blueprint(api)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
