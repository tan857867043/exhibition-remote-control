package main

import (
	"exhibition-hub/hub"
	"log"
	"net/http"
)

func main() {
	hub.InitRouter()

	log.Println("展厅远程控制数据中转中心已在 :8080 端口启动...")
	err := http.ListenAndServe(":8080", nil)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
