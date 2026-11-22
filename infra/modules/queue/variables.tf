variable "project_name" {
  type = string
}

variable "visibility_timeout_seconds" {
  description = "How long a received message stays hidden from other workers. Must be longer than the slowest job; the app's job lease (JOB_LEASE_SECONDS, default 110) is kept just under it."
  type        = number
  default     = 120
}

variable "max_receive_count" {
  description = "Deliveries before a message moves to the dead-letter queue. Must equal the app's JOB_MAX_ATTEMPTS (default 3)."
  type        = number
  default     = 3
}
