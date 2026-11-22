# Conversion jobs. The API sends a small pointer message per job; the worker
# receives it, does the conversion and deletes the message.

# Messages that fail max_receive_count times land here instead of looping
# forever. Anything in this queue is a job that needs a human to look at it, so
# the observability module alarms on it.
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.project_name}-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
}

resource "aws_sqs_queue" "jobs" {
  name = "${var.project_name}-jobs"

  # While a worker is converting, the message is hidden for this long. If the
  # worker dies, it reappears afterwards and another worker picks it up.
  visibility_timeout_seconds = var.visibility_timeout_seconds

  # Long polling: a receive call waits up to 20 s for a message instead of
  # returning empty straight away, which cuts empty receives (and cost).
  receive_wait_time_seconds = 20

  message_retention_seconds = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# Only this queue may use the dead-letter queue
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}
