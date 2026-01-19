# Schema

table_schema	table_name	column_name	data_type	is_nullable
public	argument	id	integer	NO
public	argument	topic_id	integer	YES
public	argument	claim_text	text	NO
public	argument	type	USER-DEFINED	YES
public	argument	base_weight	numeric	NO
public	argument	created_at	timestamp with time zone	NO
public	issue	id	integer	NO
public	issue	topic_id	integer	NO
public	issue	question	text	NO
public	issue	status	USER-DEFINED	NO
public	issue	created_at	timestamp with time zone	NO
public	issue_position	id	integer	NO
public	issue_position	issue_id	integer	NO
public	issue_position	argument_id	integer	NO
public	qbaf_result	run_id	integer	NO
public	qbaf_result	argument_id	integer	NO
public	qbaf_result	final_strength	numeric	NO
public	qbaf_result	status	USER-DEFINED	NO
public	qbaf_run	id	integer	NO
public	qbaf_run	topic_id	integer	NO
public	qbaf_run	method	text	NO
public	qbaf_run	created_at	timestamp with time zone	NO
public	recording	id	integer	NO
public	recording	created_at	timestamp with time zone	YES
public	recording	name	text	YES
public	recording	audio_url	text	YES
public	recording	transcript	text	YES
public	recording	summary	text	YES
public	recording	local_audio	text	YES
public	recording	nas_audio	text	YES
public	recording	duration	integer	YES
public	recording	notes	text	YES
public	recording	archived	boolean	YES
public	relation	id	integer	NO
public	relation	topic_id	integer	NO
public	relation	src_id	integer	NO
public	relation	dst_id	integer	NO
public	relation	kind	USER-DEFINED	NO
public	relation	weight	numeric	NO
public	relation	created_at	timestamp with time zone	NO
public	speaker_to_user	recording_id	integer	NO
public	speaker_to_user	speaker_id	integer	NO
public	speaker_to_user	user_id	integer	NO
public	todo	id	integer	NO
public	todo	name	text	NO
public	todo	desc	text	YES
public	todo	status	text	YES
public	todo	user_id	integer	YES
public	todo	created_at_recording_id	integer	YES
public	todo	updated_at_recording_id	integer	YES
public	topic	id	integer	NO
public	topic	name	text	NO
public	topic	desc	text	YES
public	topic	created_at	timestamp with time zone	YES
public	user	id	integer	NO
public	user	first_name	text	NO
public	user	last_name	text	YES
public	user	role	text	YES
