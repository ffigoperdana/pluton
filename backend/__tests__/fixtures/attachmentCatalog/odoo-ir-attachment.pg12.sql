--
-- PostgreSQL database dump
--

-- Dumped from database version 12.22
-- Dumped by pg_dump version 12.22

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: aa_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aa_notes (
    id integer NOT NULL,
    name character varying,
    comment text
);


--
-- Name: aa_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.aa_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: aa_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.aa_notes_id_seq OWNED BY public.aa_notes.id;


--
-- Name: ir_attachment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ir_attachment (
    id integer NOT NULL,
    name character varying NOT NULL,
    description text,
    res_model character varying,
    res_field character varying,
    res_id integer,
    company_id integer,
    type character varying DEFAULT 'binary'::character varying NOT NULL,
    url character varying(1024),
    public boolean,
    access_token character varying,
    db_datas bytea,
    store_fname character varying,
    file_size integer,
    checksum character varying,
    mimetype character varying,
    index_content text,
    original_id integer,
    create_uid integer,
    create_date timestamp without time zone,
    write_uid integer,
    write_date timestamp without time zone
);


--
-- Name: ir_attachment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ir_attachment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ir_attachment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ir_attachment_id_seq OWNED BY public.ir_attachment.id;


--
-- Name: zz_after; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zz_after (
    id integer NOT NULL,
    note text
);


--
-- Name: zz_after_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.zz_after_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: zz_after_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.zz_after_id_seq OWNED BY public.zz_after.id;


--
-- Name: aa_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aa_notes ALTER COLUMN id SET DEFAULT nextval('public.aa_notes_id_seq'::regclass);


--
-- Name: ir_attachment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ir_attachment ALTER COLUMN id SET DEFAULT nextval('public.ir_attachment_id_seq'::regclass);


--
-- Name: zz_after id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zz_after ALTER COLUMN id SET DEFAULT nextval('public.zz_after_id_seq'::regclass);


--
-- Data for Name: aa_notes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aa_notes (id, name, comment) FROM stdin;
1	Example Partner	COPY public.ir_attachment (id, name, store_fname) FROM stdin;\n1\tdecoy.pdf\tde/decoy
2	Second	\\.\nnot an end marker
\.


--
-- Data for Name: ir_attachment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ir_attachment (id, name, description, res_model, res_field, res_id, company_id, type, url, public, access_token, db_datas, store_fname, file_size, checksum, mimetype, index_content, original_id, create_uid, create_date, write_uid, write_date) FROM stdin;
1	Faktur_Januari.pdf	\N	account.move	\N	18342	\N	binary	\N	\N	\N	\N	3f/3f9c2a81e0b7d4c1f2a3b4c5d6e7f8091a2b3c4d	421888	3f9c2a81e0b7d4c1f2a3b4c5d6e7f8091a2b3c4d	application/pdf	Faktur\tJanuari\nTotal: Rp 1.000.000\\	\N	\N	2026-01-05 08:15:00	\N	\N
2	Laporan\tTab\nBaris.xlsx	\N	project.task	\N	905	\N	binary	\N	\N	\N	\N	0d/0d4e7f12aa00112233445566778899aabbccddee	90112	0d4e7f12aa00112233445566778899aabbccddee	application/vnd.openxmlformats-officedocument.spreadsheetml.sheet	\N	\N	\N	2026-02-01 10:00:00	\N	\N
3	C:\\Users\\example\\Surat "Resmi".docx	\N	hr.employee	\N	211	\N	binary	\N	\N	\N	\N	a7/a71be09d44aabbccddeeff00112233445566778899	30720	a71be09d44aabbccddeeff00112233445566778899	application/msword	\N	\N	\N	2026-03-10 09:30:00	\N	\N
4	Ringkasan rapat – Q3 ✓.pdf	\N	mail.message	\N	77	\N	binary	\N	\N	\N	\N	b1/b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0	2048	b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0	application/pdf	teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang teks panjang 	\N	\N	2026-04-01 12:00:00	\N	\N
5	image_1920	\N	product.template	image_1920	12	\N	binary	\N	\N	\N	\N	c4/c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3	51200	c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3	image/png	\N	\N	\N	2026-05-01 07:00:00	\N	\N
6	stored-in-database.txt	\N	res.partner	\N	1	\N	binary	\N	\N	\N	\\x00ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a0900ff5c0a09	\N	320	\N	text/plain	\N	\N	\N	\N	\N	\N
7	Website link	\N	\N	\N	\N	\N	url	https://example.internal/page	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N
\.


--
-- Data for Name: zz_after; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.zz_after (id, note) FROM stdin;
1	after the attachment table
\.


--
-- Name: aa_notes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.aa_notes_id_seq', 2, true);


--
-- Name: ir_attachment_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ir_attachment_id_seq', 7, true);


--
-- Name: zz_after_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.zz_after_id_seq', 1, true);


--
-- Name: aa_notes aa_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aa_notes
    ADD CONSTRAINT aa_notes_pkey PRIMARY KEY (id);


--
-- Name: ir_attachment ir_attachment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ir_attachment
    ADD CONSTRAINT ir_attachment_pkey PRIMARY KEY (id);


--
-- Name: zz_after zz_after_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zz_after
    ADD CONSTRAINT zz_after_pkey PRIMARY KEY (id);


--
-- PostgreSQL database dump complete
--

