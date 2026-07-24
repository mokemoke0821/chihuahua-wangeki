from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r"^ws/room/(?P<code>[A-Za-z0-9]{5})/$", consumers.GameConsumer.as_asgi()),
]
