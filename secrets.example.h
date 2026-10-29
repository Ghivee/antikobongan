// Salin file ini menjadi secrets.h lalu isi kredensial asli.
// secrets.h sudah masuk .gitignore dan tidak boleh dibagikan.
#ifndef SECRETS_H
#define SECRETS_H

#define SECRET_WIFI_SSID     "GANTI_SSID_WIFI"
#define SECRET_WIFI_PASSWORD "GANTI_PASSWORD_WIFI"

// Broker MQTT. Biarkan seperti ini untuk broker publik HiveMQ (tanpa login).
// Untuk broker privat (HiveMQ Cloud / EMQX): isi host, set TLS ke 1, dan isi
// akun PERANGKAT (yang boleh publish hanya ke topik node ini).
#define SECRET_MQTT_HOST     "broker.hivemq.com"
#define SECRET_MQTT_TLS      0
#define SECRET_MQTT_USERNAME ""
#define SECRET_MQTT_PASSWORD ""

#endif
