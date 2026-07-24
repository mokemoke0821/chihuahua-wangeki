"""urls.py — index.html / core.js / ai.js を repoルートから配信（複製しない=ドリフト防止）."""
import mimetypes

from django.conf import settings
from django.contrib import admin
from django.http import FileResponse, Http404, HttpResponseNotFound
from django.urls import path, re_path

# repoルート直下で配信を許可するファイル（オンライン対戦クライアントはローカル対戦UIを流用）
_ALLOWED = {"index.html", "core.js", "ai.js"}


def serve_repo_file(request, name="index.html"):
    if name not in _ALLOWED:
        return HttpResponseNotFound("not allowed")
    fp = settings.REPO_ROOT / name
    if not fp.exists():
        raise Http404(name)
    ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
    return FileResponse(open(fp, "rb"), content_type=ctype)


urlpatterns = [
    path("admin/", admin.site.urls),
    path("", serve_repo_file, {"name": "index.html"}),
    re_path(r"^(?P<name>(index\.html|core\.js|ai\.js))$", serve_repo_file),
]
