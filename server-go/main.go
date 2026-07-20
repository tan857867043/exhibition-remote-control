package main

import (
	"exhibition-hub/hub"
	"log"
	"net/http"
)

func main() {
	hub.InitRouter()

	log.Println("展厅远程控制数据中转中心已在 :38921 端口启动...")
	err := http.ListenAndServe(":38921", nil)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
